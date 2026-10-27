import { describe, expect, test } from "bun:test"
import { PermissionV2 } from "@miao/core/permission"

function rule(action: string, resource: string, effect: PermissionV2.Effect) {
  return { action, resource, effect }
}

describe("PermissionV2.decide", () => {
  test("a rule-less agent denies everything, saved approvals included", () => {
    const decided = PermissionV2.decide({
      actions: ["read"],
      resources: ["a.ts"],
      saved: [rule("read", "*", "allow")],
    })
    expect(decided.effect).toBe("deny")
  })

  test("a configured deny beats a later saved allow", () => {
    const decided = PermissionV2.decide({
      actions: ["bash"],
      resources: ["git push origin"],
      configured: [rule("bash", "git push *", "deny")],
      saved: [rule("bash", "git *", "allow")],
    })
    expect(decided.effect).toBe("deny")
    expect(decided.rules).toEqual([rule("bash", "git push *", "deny")])
  })

  test("the last matching rule decides", () => {
    expect(
      PermissionV2.decide({
        actions: ["read"],
        resources: ["secret.env"],
        configured: [rule("read", "*", "allow"), rule("read", "*.env", "ask")],
      }).effect,
    ).toBe("ask")
    expect(
      PermissionV2.decide({
        actions: ["read"],
        resources: ["secret.env"],
        configured: [rule("read", "*.env", "ask"), rule("read", "*", "allow")],
      }).effect,
    ).toBe("allow")
  })

  test("saved approvals lift asks but never denies", () => {
    expect(
      PermissionV2.decide({
        actions: ["bash"],
        resources: ["git status"],
        configured: [rule("bash", "git status *", "ask")],
        saved: [rule("bash", "git status *", "allow")],
      }).effect,
    ).toBe("allow")
  })

  test("no matching rule asks", () => {
    expect(PermissionV2.decide({ actions: ["read"], resources: ["a.ts"], configured: [] }).effect).toBe("ask")
  })

  test("multi-resource requests take the worst effect", () => {
    expect(
      PermissionV2.decide({
        actions: ["read"],
        resources: ["a.ts", "secret.env"],
        configured: [rule("read", "*", "allow"), rule("read", "*.env", "ask")],
      }).effect,
    ).toBe("ask")
  })

  test("explicit drops bare wildcard-action rules", () => {
    expect(
      PermissionV2.decide({
        actions: ["sandbox-escape"],
        resources: ["host"],
        configured: [rule("*", "*", "allow")],
        explicit: true,
      }).effect,
    ).toBe("ask")
  })

  test("aliases decide exactly like the action they name", () => {
    expect(
      PermissionV2.decide({
        actions: ["bash", "terminal"],
        resources: ["git status"],
        configured: [rule("terminal", "git status *", "allow")],
      }).effect,
    ).toBe("allow")
  })
})
