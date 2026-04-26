async function testFull() {
  console.log("=== 1. INITIALIZE ===");
  const initInput = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }
  };
  console.log("Input:", JSON.stringify(initInput, null, 2));

  const initRes = await fetch('http://localhost:3000/api/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    body: JSON.stringify(initInput)
  });
  
  const sessionId = initRes.headers.get('mcp-session-id');
  console.log("\nOutput Header mcp-session-id:", sessionId);
  
  if (!sessionId) return;
  
  console.log("\n=== 2. LOGIN ===");
  const loginInput = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'login', arguments: { email: 'dietly@linek.dev', password: 'n34Biz63bq8#Ugc8BOb' } }
  };
  console.log("Input:", JSON.stringify(loginInput, null, 2));
  
  const loginRes = await fetch('http://localhost:3000/api/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'mcp-session-id': sessionId },
    body: JSON.stringify(loginInput)
  });
  
  const rawLoginOut = await loginRes.text();
  console.log("Raw Output:", rawLoginOut.trim());
  try { // Try parse the SSE message data if possible
    const dataStr = rawLoginOut.split('data: ')[1];
    if (dataStr) {
        const parsed = JSON.parse(dataStr);
        if (parsed.result && parsed.result.content && parsed.result.content[0]) {
            console.log("\nParsed Tool Output (Login):");
            console.log(JSON.stringify(JSON.parse(parsed.result.content[0].text), null, 2));
        }
    }
  } catch(e) {}
  
  console.log("\n=== 3. GET_PROFILE ===");
  const profileInput = {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'get_profile', arguments: { email: 'dietly@linek.dev' } }
  };
  console.log("Input:", JSON.stringify(profileInput, null, 2));
  
  const profileRes = await fetch('http://localhost:3000/api/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'mcp-session-id': sessionId },
    body: JSON.stringify(profileInput)
  });
  
  const rawProfileOut = await profileRes.text();
  console.log("Raw Output:", rawProfileOut.trim());
  try {
    const dataStr = rawProfileOut.split('data: ')[1];
    if (dataStr) {
        const parsed = JSON.parse(dataStr);
        if (parsed.result && parsed.result.content && parsed.result.content[0]) {
            console.log("\nParsed Tool Output (Get Profile):");
            console.log(JSON.stringify(JSON.parse(parsed.result.content[0].text), null, 2));
        }
    }
  } catch(e) {}
}

testFull();
