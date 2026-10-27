import { startMockServer } from "./server.js";

const port = Number(process.env.PORT ?? 8787);
const mock = await startMockServer(port);
console.log(`mock Saifuro API on ${mock.baseUrl}`);
console.log(`JWKS: ${mock.jwksUrl}`);
console.log(`org key: ${mock.orgKey}`);
