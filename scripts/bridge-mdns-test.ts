/**
 * mDNS candidate rewriting for desktop pairing.
 *
 * Run: npm run test:bridge-mdns
 */
import assert from "node:assert/strict";
import {
  expandLocalCandidate,
  expandLocalSdp,
  localMdnsHosts,
} from "../src/bridge/mdns.js";

const hosts = ["127.0.0.1", "192.168.2.10"];

assert.ok(localMdnsHosts().includes("127.0.0.1"), "loopback is always a candidate host");

const sdp = [
  "v=0",
  "a=candidate:0 1 UDP 2122252543 61a34ba5-c22a-4a56-a6bc-ee79efd7499b.local 54397 typ host",
  "a=candidate:1 1 TCP 2105524479 61a34ba5-c22a-4a56-a6bc-ee79efd7499b.local 9 typ host tcptype active",
  "a=candidate:2 1 UDP 1679818751 203.0.113.9 60000 typ srflx raddr 0.0.0.0 rport 0",
].join("\r\n");

const expanded = expandLocalSdp(sdp, hosts);
for (const host of hosts) {
  assert.ok(
    expanded.includes(`a=candidate:0 1 UDP 2122252543 ${host} 54397 typ host`),
    `UDP candidate expanded to ${host}`,
  );
  assert.ok(
    expanded.includes(`a=candidate:1 1 TCP 2105524479 ${host} 9 typ host tcptype active`),
    `TCP candidate expanded to ${host}`,
  );
}
assert.ok(expanded.includes("203.0.113.9 60000"), "non-mDNS candidates are untouched");
assert.ok(!expanded.includes(".local"), "no .local address survives");
assert.equal(
  expandLocalSdp("a=candidate:0 1 UDP 1 10.0.0.1 5 typ host", hosts),
  "a=candidate:0 1 UDP 1 10.0.0.1 5 typ host",
  "ordinary candidates are unchanged",
);

const candidate = {
  candidate: "candidate:0 1 UDP 2122252543 61a34ba5-c22a-4a56-a6bc-ee79efd7499b.local 54397 typ host",
  sdpMLineIndex: 0,
  sdpMid: "0",
  usernameFragment: "d34aa9e6",
};
const candidates = expandLocalCandidate(candidate, hosts);
assert.equal(candidates.length, hosts.length);
for (let i = 0; i < hosts.length; i++) {
  assert.equal(
    candidates[i].candidate,
    `candidate:0 1 UDP 2122252543 ${hosts[i]} 54397 typ host`,
  );
  assert.equal(candidates[i].sdpMLineIndex, 0);
  assert.equal(candidates[i].usernameFragment, "d34aa9e6");
}
assert.equal(candidate.candidate.includes(".local"), true, "the input is not mutated");

const end = { candidate: "", sdpMLineIndex: 0, sdpMid: "0" };
assert.deepEqual(expandLocalCandidate(end, hosts), [end]);
assert.deepEqual(
  expandLocalCandidate({ candidate: "candidate:0 1 UDP 1 10.0.0.1 5 typ host" }, hosts).length,
  1,
  "non-mDNS candidate is a single value",
);

console.log("bridge-mdns: candidates expand without an mDNS responder ok");
