import type { MessagePort } from "node:worker_threads";

interface MessageData {
  event: `${"bus" | "expose" | "message"}:${string}`;
  data: any;
}

/*
Prefixes
- bus: internal events
- expose: exposed object
- message: custom user events
*/

export class MessageBus {
  isBounded: boolean = false;

  port: MessagePort;
  listeners: {
    event: string;
    cb: Function;
    type: "builtin" | "expose" | "user";
    waiting?: string;
  }[] = [];

  exposed: Exposed[] = [];

  constructor(port?: MessagePort) {
    this.listeners = [];
    if (port) this.bind(port);
  }

  // TODO: Make this async to wait for bind confirmation
  async bind(port: MessagePort) {
    this.port = port;

    this.port.on("message", (val: MessageData) => {
      if (!val) return;
      if (val.event.startsWith("expose:")) {
        if (val.event === "expose:register") {
          const v = val as { event: string; data: ExposedData };
          this.exposed.push(
            new Exposed(this.#createExposedBus(v.data.specifier), {
              specifier: v.data.specifier,
              keys: v.data.keys,
              interactable: v.data.interactable
            })
          );
        } else console.log(JSON.stringify(val, null, 2));
        return;
      } else if (val.event === "bus:bind" || val.event === "bus:bindSuccess") {
        if (val.event === "bus:bind") this.port.emit("message", { event: "bus:bindSuccess" });
        else if (val.event === "bus:bindSuccess") {
          const data = this.exposed.map((e) => {
            return {
              specifier: e.specifier,
              keys: e.keys,
              interactable: e.interactable
            };
          });
          this.port.emit("message", {
            event: "bus:expose",
            data
          });
        }
        return;
      } else if (val.event === "bus:expose" || val.event === "bus:exposeSuccess") {
        const v = val as { event: string; data: ExposedData[] };
        if (val.event === "bus:expose") {
          // other thread is first binder
          this.port.emit("message", {
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

        // Add received exposed
        for (const i of v.data) {
          this.exposed.push(
            new Exposed(this.#createExposedBus(i.specifier), {
              specifier: i.specifier,
              keys: i.keys,
              interactable: i.interactable
            })
          );
        }
        console.log("bounded");
        return (this.isBounded = true);
      }
      const ls = this.listeners.filter((e) => e.event === val.event);
      for (const l of ls) l.cb(val.data);
    });

    this.port.emit("message", { event: "bus:bind" });
  }

  /**
   * Listens to events received from the bound port
   */
  on<T extends string>(event: T, cb: (data: any) => any) {
    this.listeners.push({ event, cb, type: "user" });
  }

  /**
   * Emits an event to the bound port
   */
  emit<T extends string>(event: T, data: any) {
    if (!this.port) return;
    this.port.emit("message", { event, data });
  }

  /**
   * Exposes an object to the other thread, which allows function and values from within to be accesible from the other thread,
   * however parameters in the function must be cloneable, so callbacks are not permitted.
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
    this.#bufferEmit("message", {
      event: `expose:register`,
      data: {
        specifier,
        keys: _keys,
        interactable
      }
    });
  }

  getExposed(specifier: string) {
    const f = this.exposed.find((e) => e.specifier === specifier);
    if (f === undefined) return undefined;
    return new Proxy(
      {},
      {
        get: (_t, prop) => {
          return f.get(prop.toString());
        }
      }
    );
  }

  #bufferEmit(type: "message", d: { event: string; data: any; waiting?: string }) {}

  #createExposedBus(specifier: string): EventBus {
    return {
      on: (event, cb) => this.listeners.push({ event: `expose:${event}`, type: "expose", cb }),
      emit: (event, data) => {
        const id = Math.random().toString(36).slice(2);
        this.#bufferEmit("message", {
          event: `expose:${event}`,
          data: {
            ...data,
            specifier
          },
          waiting: id
        });
        return new Promise((res) => {
          this.listeners.unshift({
            event: `expose:res`,
            type: "expose",
            waiting: id,
            cb: (e) => {
              console.log(e);
              res(e);
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
  }

  get(key: string): Promise<unknown> {
    if (this.keys.find((e) => e.k === key) === undefined) return undefined;
    if (this.obj !== undefined || this.secondary === true) {
      return this.bus.emit("get", { key });
    } else {
      return this.obj[key];
    }
  }

  async set(key: string) {}
}
