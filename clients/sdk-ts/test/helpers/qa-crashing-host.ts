/**
 * A host that dumps a frame and then dies non-zero.
 *
 * This is the shape the wire tap exists to witness: the host says its last
 * words and crashes. The write completes before the exit, so all the bytes
 * reach the shim and the ONLY thing at risk is the status — which is exactly
 * the property under test.
 *
 * Usage: node qa-crashing-host.js [exitCode]
 */

const status = Number(process.argv[2] ?? 7);
const frame = JSON.stringify({ jsonrpc: "2.0", method: "host/note", params: { note: "last words" } });

process.stdout.write(`${frame}\n`, () => process.exit(status));
