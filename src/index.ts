import type { MessagePort } from "node:worker_threads";

interface MessageData {
  event: `${"bus" | "expose" | "message"}:${string}`;
  data: any;
}

interface ExposeEventData {
  event: "expose:get" | "expose:set";
  data: {
    specifier: string;
    key: string;
    value?: any;
  };
}

type RequestCallback = (val: any) => void;

/*
Prefixes
- bus: internal events
- expose: exposed object
- message: custom user events
*/

export class MessageBus {
  bounded: boolean = false;
  port: MessagePort;
  listeners: {
    event: string;
    cb: Function;
  }[];

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
        const v = val as ExposeEventData;
        const method = v.event.split(":")[1] as "get" | "set";
        const exposeObj = this.exposed.find((e) => e.specifier === v.data.specifier);
      }
      if (val.event === "bus:bind" || val.event === "bus:bindSuccess") {
        if (val.event === "bus:bind") this.port.emit("message", { event: "bus:bindSuccess" });
        return (this.bounded = true);
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
    this.listeners.push({ event, cb });
  }

  /**
   * Emits an event to the bound port
   */
  emit<T>(event: T, data: any) {
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
    const _keys = (keys === null || keys === undefined ? Object.keys(obj) : keys).map((e: string | keyof T) =>
      e.toString()
    );
    const exposed = new Exposed(this, specifier, obj, _keys, interactable);
    this.exposed.push(exposed);
  }

  _handleExposeRequest(expose: Exposed, method: "get", key: string, cb: RequestCallback): Promise<unknown>;
  _handleExposeRequest(
    expose: Exposed,
    method: "set",
    key: string,
    value: unknown,
    cb: RequestCallback
  ): Promise<unknown>;
  async _handleExposeRequest(
    expose: Exposed,
    method: "get" | "set",
    key: string,
    value: unknown | RequestCallback,
    cb?: RequestCallback
  ) {
    // handle request
  }
}

interface ExposedData {
  specifier: string;
  keys: string[];
  interactable: boolean;
}

class Exposed {
  bus: MessageBus;
  specifier: string;
  obj: Object;
  keys: string[];
  interactable: boolean;
  secondary: boolean;

  constructor(bus: MessageBus, obj: ExposedData);
  constructor(bus: MessageBus, specifier: string, obj: Object, keys: string[], interactable: boolean);
  constructor(bus: MessageBus, specifier: string | ExposedData, obj?: Object, keys?: string[], interactable?: boolean) {
    this.bus = bus;
    if (typeof specifier === "string" && obj && keys && interactable) {
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
    } // else handle error?
  }

  get(key: string): unknown | Promise<unknown> {
    if (this.obj !== undefined) {
      return new Promise((resolve) => {
        this.bus._handleExposeRequest(this, "get", key, (res) => {
          resolve(res);
        });
      });
    } else {
      return this.obj[key];
    }
  }

  async set(key: string) {}
}
