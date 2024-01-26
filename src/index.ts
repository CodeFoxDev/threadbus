import type { MessagePort } from "node:worker_threads";
import { MessageChannel, isMainThread } from "node:worker_threads";

type Events =
  | "bus:bind"
  | "bus:bindSuccess"
  | "bus:expose"
  | "bus:exposeSuccess"
  | `expose:register`
  | `expose:get`
  | `expose:call`
  | `expose:set`
  | `expose:res`
  | `user:${string}`;

interface EventData {
  event: Events;
  data: any;
}

interface Listener {
  event: Events;
  cb: (data: EventData) => void;
  waiting?: string;
}

export class Bus {
  /**
   * The primary port; this thread's port
   */
  port?: MessagePort;

  /**
   * The secondary port, will be undefined if this bus was constructed with an existing port, which indicates this is the client.
   * This port will be defined if no port was passed in the constructer, which will then create a MessageChannel,
   * this should be passed to the thread you want to communicate with
   */
  client?: MessagePort;

  /**
   * Whether or not the bus has been bounded to another bus
   */
  bounded: boolean = false;

  exposed: Exposed[] = [];

  #sab: SharedArrayBuffer = new SharedArrayBuffer(4);
  #listeners: Listener[] = [];
  #confirm = { cb: () => null, done: false };

  constructor() {}

  #initListener() {
    this.port.on("message", (data: EventData) => {
      if (data.event === "bus:bind" || data.event === "bus:bindSuccess") {
        if (data.event === "bus:bind") {
          this.port.postMessage({ event: "bus:bindSuccess" });
        } else if (data.event === "bus:bindSuccess") {
          this.port.postMessage({
            event: "bus:expose",
            data: this.exposed.map((e) => {
              return {
                specifier: e.specifier,
                keys: e.keys,
                interactable: e.interactable
              };
            })
          });
        }
        this.bounded = true;
      } else if (data.event === "bus:expose" || data.event === "bus:exposeSuccess") {
        const v = data as { event: string; data: ExposedData[] };
        if (data.event === "bus:expose") {
          this.port.postMessage({
            event: "bus:exposeSuccess",
            data: this.exposed.map((e) => {
              return {
                specifier: e.specifier,
                keys: e.keys,
                interactable: e.interactable
              };
            })
          });
        }

        for (const i of v.data) {
          this.exposed.push(
            new Exposed(this.#createExposedBus(i.specifier), {
              specifier: i.specifier,
              keys: i.keys,
              interactable: i.interactable
            })
          );
        }

        this.#confirm.done = true;
        this.#confirm.cb();
      } else {
        const f = this.#listeners.find((e) => e.event === data.event);
        if (f !== undefined) f.cb(data.data);
      }
    });
  }

  /**
   * Creates a new channel and returns the client's port to be passed in the worker
   */
  createChannel() {
    const t = new MessageChannel();
    this.port = t.port1;
    this.client = t.port2;
    this.#initListener();
    return {
      port: this.client,
      sab: this.#sab
    };
  }

  /**
   * Binds this bus to the given port, which will result in this Bus becoming the client,
   * uses the SharedArrayBuffer for Atomics.wait to avoid async
   */
  bind(port: MessagePort, sab: SharedArrayBuffer): void {
    this.port = port;
    this.#initListener();

    this.port.postMessage({ event: "bus:bind" });
  }

  /**
   * Waits for a bind confirmation from the client
   */
  async confirm(): Promise<void> {
    return new Promise((resolve) => {
      const d = () => {
        this.bounded = true;
        resolve();
      };
      if (this.#confirm.done === true) d();
      this.#confirm.cb = () => d();
    });
  }

  /**
   * Listens to events received from the bound port
   */
  on<T extends Events>(event: T, cb: (data: any) => any) {
    this.#listeners.push({ event: `user:${event}`, cb });
  }

  /**
   * Listens to events received from the bound port, and removes the event listener after the first response,
   * which means that the callback be only ever be executed once
   */
  once<T extends Events>(event: T, cb: (data: any) => any) {
    const l: Listener = {
      event: `user:${event}`,
      cb: (d) => {
        cb(d);
        const i = this.#listeners.indexOf(l);
        this.#listeners.splice(i, 1);
      }
    };
    this.#listeners.push(l);
  }

  /**
   * Emits an event to the bound port
   */
  emit<T extends Events>(event: T, data: any) {
    if (!this.port) return;
    this.port.postMessage({ event: `user:${event}`, data });
  }

  /**
   * Exposes an object to the other thread, which allows function and values from within to be accesible from the other thread,
   * however parameters in the function must be cloneable, so callbacks are not permitted.
   * This needs to be done before binding the bus to the port.
   *
   * If you get values or call functions from an other thread it will send an event which will get the value, or call the function on the thread it was registered.
   * Which means that the values will be the same on both threads
   * @param keys An array of the keys to expose, leave empty or null to expose all keys
   * @param interactable Whether or not the value can be updated from another thread, functions and other non-cloneable values will never be updated, defaults to false
   */
  expose<T extends Object>(specifier: string, obj: T, keys?: (keyof T)[], interactable?: boolean) {
    interactable ??= false;
    const _keys = (keys === null || keys === undefined ? Object.keys(obj) : keys).map((e: string | keyof T) => {
      if (!obj.hasOwnProperty(e)) return;
      return {
        k: e.toString(),
        t: typeof obj[e as keyof T] === "function" ? "function" : "value"
      };
    });

    const exposed = new Exposed(this.#createExposedBus(specifier), specifier, obj, _keys, interactable);
    this.exposed.push(exposed);
    if (this.bounded === true)
      this.port.postMessage({
        event: "expose:register",
        data: {
          specifier,
          keys: _keys,
          interactable
        }
      } as EventData);
  }

  /**
   * Returns a proxy that will allow you to interact with the object if it has been exposed, otherwise returns `undefined`
   */
  getExposed<T extends { [key: string]: any }>(specifier: string): T {
    const f = this.exposed.find((e) => e.specifier === specifier);
    if (f === undefined) return undefined;
    // @ts-ignore
    return new Proxy(
      {},
      {
        get(_t, prop) {
          const k = f.keys.find((e) => e.k === prop);
          if (k === undefined) return undefined;
          if (k.t === "function") return (...a) => f.call(prop.toString(), a);
          return f.get(prop.toString());
        },
        set(_t, prop, value) {
          const k = f.keys.find((e) => e.k === prop);
          if (k === undefined || k.t === "function") return false;
          f.set(prop.toString(), value);
          return true;
        }
      }
    );
  }

  #createExposedBus(specifier: string): EventBus {
    return {
      on: (event, cb) => {
        this.#listeners.push({
          event: `expose:${event}`,
          cb: async (e: unknown) => {
            const data = e as { key: string; specifier: string; waiting: string };
            if (specifier !== data.specifier) return;
            const res = await cb(data);

            this.port.postMessage({
              event: `expose:res`,
              data: {
                res,
                waiting: data.waiting
              }
            } as EventData);
          }
        });
      },
      emit: (event, data) => {
        const id = Math.random().toString(36).slice(2);
        this.port.postMessage({
          event: `expose:${event}`,
          data: {
            ...data,
            specifier,
            waiting: id
          }
        });
        return new Promise((res) => {
          this.#listeners.unshift({
            event: `expose:res`,
            waiting: id,
            cb: (e: unknown) => {
              const data = e as { res: string; waiting: string };
              if (data.waiting !== id) return;
              res(data.res);
            }
          });
        });
      }
    };
  }
}

interface ExposedEvent {
  get: {
    req: { key: string };
    res: any;
  };
  call: {
    req: { key: string; args: any[] };
    res: any;
  };
  set: {
    req: { key: string; value: any };
    res: any;
  };
}

type Keys = { k: string; t: string };

interface ExposedData {
  specifier: string;
  keys: Keys[];
  interactable: boolean;
}

interface EventBus {
  on<T extends keyof ExposedEvent>(event: T, cb: (data: ExposedEvent[T]["req"]) => ExposedEvent[T]["res"]): void;
  emit<T extends keyof ExposedEvent>(event: T, data: ExposedEvent[T]["req"]): Promise<ExposedEvent[T]["res"]>;
}

class Exposed {
  bus: EventBus;
  specifier: string;
  obj: Object;
  keys: Keys[];
  interactable: boolean;
  secondary: boolean;

  constructor(bus: EventBus, obj: ExposedData);
  constructor(bus: EventBus, specifier: string, obj: Object, keys: Keys[], interactable: boolean);
  constructor(bus: EventBus, specifier: string | ExposedData, obj?: Object, keys?: Keys[], interactable?: boolean) {
    interactable ??= false;
    this.bus = bus;
    if (typeof specifier === "string" && obj && keys) {
      this.specifier = specifier;
      this.obj = obj;
      this.keys = keys;
      this.interactable = interactable;
      this.secondary = false;
    } else if (typeof specifier === "object") {
      this.secondary = true;
      this.obj = undefined;
      this.specifier = specifier.specifier;
      this.keys = specifier.keys;
      this.interactable = specifier.interactable;
    }

    this.bus.on("get", ({ key }) => this.get(key));
    this.bus.on("set", ({ key, value }) => this.set(key, value));
    this.bus.on("call", ({ key, args }) => this.call(key, args));
  }

  get(key: string): Promise<unknown> {
    if (this.keys.find((e) => e.k === key) === undefined) return undefined;
    if (this.obj === undefined || this.secondary === true) {
      return this.bus.emit("get", { key });
    } else {
      return this.obj[key];
    }
  }

  async call(key: string, args: any[]) {
    if (this.keys.find((e) => e.k === key) === undefined) return undefined;
    if (this.obj === undefined || this.secondary === true) {
      return this.bus.emit("call", { key, args });
    } else {
      return this.obj[key](...args);
    }
  }

  async set(key: string, value: any) {
    if (this.interactable === false) {
      console.error("Tried to edit property on exposed object, but interactable was set to false");
      return undefined;
    }
    if (this.keys.find((e) => e.k === key) === undefined) return undefined;
    if (this.obj === undefined || this.secondary === true) {
      const s = await this.bus.emit("set", { key, value });
      if (s === false) return undefined;
      else return value;
    } else {
      return (this.obj[key] = value);
    }
  }
}
