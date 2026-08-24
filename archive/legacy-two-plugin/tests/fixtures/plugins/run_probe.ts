await new Response(Deno.stdin.readable).text();
new Deno.Command('/bin/true').spawn();
