import { DeviceGrants } from "../../src/grants"
import { SecureChannel } from "../../src/secure-channel"

const store = await DeviceGrants.load(process.argv[2]!)
const device = await SecureChannel.createIdentity()
for (let index = 0; index < 8; index++) {
  await store.approve({
    publicKey: device.publicKey,
    label: process.argv[3]! + index,
    permissions: ["read"],
    projectIDs: ["project"],
    sessionIDs: [],
    expiresAt: Date.now() + 60000,
  })
}
console.log(JSON.stringify({ hostID: store.hostID, publicKey: store.identity.publicKey }))
await store.close()
