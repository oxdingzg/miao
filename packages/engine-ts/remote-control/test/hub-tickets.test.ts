import { expect, test } from "bun:test"
import { HubTickets } from "../src/hub-tickets"

test("Browser tickets are host-bound, one-use, time-limited and bounded across accounts", () => {
  let now = 1000
  const tickets = HubTickets.make({ clock: () => now, maxPending: 2, maxPerAccount: 1 })
  const owner = { accountID: "owner", sessionID: "login-one", expiresAt: 100_000 }
  const other = { ...owner, accountID: "other", sessionID: "login-two" }
  const hostID = "host-0000000000001"
  const runtimeID = "runtime-0000000001"
  const issued = tickets.issue(owner, hostID, runtimeID)!
  expect(issued.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(issued.expiresAt).toBe(31_000)
  expect(tickets.issue(owner, hostID, runtimeID)).toBeUndefined()
  expect(tickets.issue(other, hostID, runtimeID)).toBeDefined()
  expect(tickets.issue({ ...other, accountID: "third" }, hostID, runtimeID)).toBeUndefined()
  expect(tickets.consume(issued.ticket, hostID)).toMatchObject({ principal: owner, hostID, runtimeID })
  expect(tickets.consume(issued.ticket, hostID)).toBeUndefined()
  const wrongRoute = tickets.issue(owner, hostID, runtimeID)!
  expect(tickets.consume(wrongRoute.ticket, "host-0000000000002")).toBeUndefined()
  expect(tickets.consume(wrongRoute.ticket, hostID)).toBeUndefined()
  const expires = tickets.issue(owner, hostID, runtimeID)!
  now = expires.expiresAt
  expect(tickets.consume(expires.ticket, hostID)).toBeUndefined()
  expect(tickets.issue({ ...owner, expiresAt: now }, hostID, runtimeID)).toBeUndefined()
  const brief = tickets.issue({ ...owner, expiresAt: now + 100 }, hostID, runtimeID)!
  expect(brief.expiresAt).toBe(now + 100)
  tickets.clear()
  expect(tickets.consume(brief.ticket, hostID)).toBeUndefined()
  expect(() => HubTickets.make({ maxPending: 0 })).toThrow()
})
