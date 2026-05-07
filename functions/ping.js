export async function onRequest() {
  return new Response(JSON.stringify({ relay: true, version: 1 }), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
