await new Response(Deno.stdin.readable).text();
console.log('this is not JSONL protocol');
