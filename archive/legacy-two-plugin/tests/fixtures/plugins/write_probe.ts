await new Response(Deno.stdin.readable).text();
await Deno.writeTextFile('/tmp/henji-probe', 'x');
