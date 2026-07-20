// Zero-dependency fake Socket.IO harness so socketHandlers.js can be
// exercised end-to-end without `npm install` (registry is blocked in this
// build sandbox -- see PROGRESS.md). Mimics just enough of the socket.io
// server API surface (io.on/to/emit, socket.on/join/emit) to drive real
// handler code and assert on broadcasts.

const { EventEmitter } = require('events');

function makeFakeIo() {
  const roomMembers = new Map(); // roomName -> Set(fakeSocket)
  const connectionHandlers = [];

  const io = {
    on(event, cb) { if (event === 'connection') connectionHandlers.push(cb); },
    to(roomName) {
      return {
        emit(event, payload) {
          const members = roomMembers.get(roomName) || new Set();
          for (const sock of members) sock._deliver(event, payload);
        }
      };
    }
  };

  function newConnection(label) {
    const emitter = new EventEmitter();
    const handlers = new Map(); // event -> fn(payload, cb)
    const received = []; // { event, payload }

    const socket = {
      id: 'fake-' + label + '-' + Math.random().toString(36).slice(2, 8),
      data: {},
      rooms: new Set(),
      label,
      on(event, fn) { handlers.set(event, fn); },
      join(roomName) {
        socket.rooms.add(roomName);
        if (!roomMembers.has(roomName)) roomMembers.set(roomName, new Set());
        roomMembers.get(roomName).add(socket);
      },
      leave(roomName) {
        socket.rooms.delete(roomName);
        if (roomMembers.has(roomName)) roomMembers.get(roomName).delete(socket);
      },
      // mirrors real socket.io: broadcast to a room EXCLUDING this socket
      to(roomName) {
        return {
          emit(event, payload) {
            const members = roomMembers.get(roomName) || new Set();
            for (const sock of members) if (sock !== socket) sock._deliver(event, payload);
          }
        };
      },
      _deliver(event, payload) { received.push({ event, payload }); },
      // test-side helper: simulate the client emitting `event` to the server
      trigger(event, payload) {
        return new Promise((resolve) => {
          const fn = handlers.get(event);
          if (!fn) return resolve({ error: 'NO_HANDLER_FOR_' + event });
          const maybePromise = fn(payload, (ack) => resolve(ack));
          // handlers that don't call cb synchronously still resolve via cb above;
          // if handler returns without ever invoking cb, avoid hanging forever
          if (maybePromise && typeof maybePromise.then === 'function') {
            maybePromise.then((v) => { if (v !== undefined) resolve(v); });
          }
        });
      },
      lastReceived(event) {
        const all = received.filter(r => r.event === event);
        return all.length ? all[all.length - 1].payload : null;
      },
      allReceived(event) { return received.filter(r => r.event === event).map(r => r.payload); },
      disconnectNow() {
        const fn = handlers.get('disconnect');
        if (fn) fn();
        for (const roomName of Array.from(socket.rooms)) socket.leave(roomName);
      }
    };
    for (const cb of connectionHandlers) cb(socket);
    return socket;
  }

  return { io, newConnection };
}

module.exports = { makeFakeIo };
