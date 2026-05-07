// Pages Function — routes WebSocket connections to the RelayRoom Durable Object.
// RelayRoom is defined in relay/worker.js (the wrapcue-relay Worker).

export async function onRequest({ request, env }) {
  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('WebSocket upgrade required', { status: 426 });
  }
  if (!env.ROOMS) {
    return new Response('Relay not configured (missing DO binding)', { status: 503 });
  }
  const stub = env.ROOMS.get(env.ROOMS.idFromName('global'));
  return stub.fetch(request);
}
