#!/usr/bin/env python3
"""Black-box G4 drill against prebuilt engine executables; never compiles code.

Example: python3 script/engine-artifact-drill.py --previous /path/to/old/engine
         --binary /path/to/new/engine --output /tmp/artifact-drill.json
Only temporary ledgers/workspaces are used. No credentials or paid calls.
"""

import argparse
import hashlib
import http.server
import json
import os
from pathlib import Path
import platform
import queue
import sqlite3
import subprocess
import tempfile
import threading


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def sse(text=None, command=None):
    delta = {"content": text}
    finish = "stop"
    if command is not None:
        delta = {"tool_calls": [{"index": 0, "id": "artifact_call", "type": "function",
                                "function": {"name": "run_command", "arguments": json.dumps({"argv": command})}}]}
        finish = "tool_calls"
    return ("data: " + json.dumps({"choices": [{"index": 0, "delta": delta, "finish_reason": finish}]})
            + "\n\ndata: " + json.dumps({"choices": [], "usage": {"prompt_tokens": 2, "completion_tokens": 1}})
            + "\n\ndata: [DONE]\n\n").encode()


class Fixture:
    def __init__(self, replies):
        self.calls = []
        self.replies = replies
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.0"

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                index = len(owner.calls)
                owner.calls.append(body)
                response = owner.replies[index] if index < len(owner.replies) else None
                self.send_response(200 if response is not None else 400)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(response or b"unexpected request")))
                self.end_headers()
                self.wfile.write(response or b"unexpected request")

            def log_message(self, *_):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.endpoint = "http://127.0.0.1:" + str(self.server.server_port) + "/fixture"

    def __enter__(self):
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *_):
        self.server.shutdown()
        self.server.server_close()


class Agent:
    def __init__(self, binary, root, endpoint):
        self.workspace = str(root / "workspace")
        self.child = subprocess.Popen(
            [str(binary), "acp", "--db", str(root / "engine.db"), "--workspace", str(root / "workspace"),
             "--provider", "openai-chat", "--model", "fixture", "--endpoint", endpoint,
             "--policy", str(root / "policy.json")],
            env={**os.environ, "OPENAI_API_KEY": "fixture-only"}, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8",
        )
        self.lines = queue.Queue()
        self.errors = []
        self.sequence = 0
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.error_reader = threading.Thread(target=self._stderr, daemon=True)
        self.reader.start()
        self.error_reader.start()

    def _read(self):
        try:
            for line in self.child.stdout:
                self.lines.put(json.loads(line))
        except Exception as error:
            self.lines.put(error)
        finally:
            self.lines.put(None)

    def _stderr(self):
        for line in self.child.stderr:
            self.errors.append(line)

    def request(self, method, params):
        self.sequence += 1
        request_id = self.sequence
        self.child.stdin.write(json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}) + "\n")
        self.child.stdin.flush()
        text = ""
        while True:
            try:
                message = self.lines.get(timeout=30)
            except queue.Empty:
                raise RuntimeError("ACP response timeout: " + method + " " + "".join(self.errors)[-2000:])
            require(message is not None, "ACP closed: " + "".join(self.errors)[-2000:])
            if isinstance(message, Exception):
                raise message
            require(message.get("method") != "session/request_permission", "unexpected permission under explicit allow policy")
            if message.get("method") == "session/update":
                update = message["params"]["update"]
                if update.get("sessionUpdate") == "agent_message_chunk":
                    text += update.get("content", {}).get("text", "")
            if message.get("id") == request_id:
                require("error" not in message, "ACP error: " + json.dumps(message))
                return message["result"], text

    def __enter__(self):
        try:
            self.request("initialize", {"protocolVersion": 1, "clientCapabilities": {}})
        except Exception:
            self.__exit__()
            raise
        return self

    def __exit__(self, *_):
        self.child.stdin.close()
        try:
            self.child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.child.kill()
            self.child.wait(timeout=5)
        self.reader.join(timeout=2)
        self.error_reader.join(timeout=2)
        self.child.stdout.close()
        self.child.stderr.close()

    def session(self):
        result, _ = self.request("session/new", {"cwd": self.workspace, "mcpServers": []})
        return result["sessionId"]

    def resume(self, session):
        _, text = self.request("session/resume", {"sessionId": session, "cwd": self.workspace, "mcpServers": []})
        require(not text, "resume duplicated historical assistant output")

    def prompt(self, session, text, answer):
        result, rendered = self.request("session/prompt", {"sessionId": session, "prompt": [{"type": "text", "text": text}]})
        require(result.get("stopReason") == "end_turn", "turn did not complete: " + json.dumps(result))
        require(rendered == answer, "unexpected or duplicate answer: " + repr(rendered))


def prepare(root):
    (root / "workspace").mkdir()
    (root / "policy.json").write_text(json.dumps({
        "mode": "workspace", "allow_process": True, "process_network": False,
        "rules": [{"tool": "*", "path": "**", "decision": "allow"}],
    }), encoding="utf-8")


def ledger(root):
    db = sqlite3.connect(root / "engine.db")
    try:
        require(db.execute("PRAGMA integrity_check").fetchone() == ("ok",), "SQLite integrity check failed")
        return db.execute("SELECT seq,kind,data FROM engine_event ORDER BY seq").fetchall()
    finally:
        # The sqlite connection context manager commits but does not close the
        # handle; leaving it open prevents temporary ledger cleanup on Windows.
        db.close()


def compatibility(previous, binary):
    with tempfile.TemporaryDirectory(prefix="miao-data-drill-") as temporary:
        root = Path(temporary).resolve()
        prepare(root)
        with Fixture([sse(text="old answer"), sse(text="upgraded answer"), sse(text="rollback answer")]) as provider:
            prefixes = []
            for index, executable in enumerate([previous, binary, previous]):
                with Agent(executable, root, provider.endpoint) as agent:
                    if index == 0:
                        session = agent.session()
                    else:
                        agent.resume(session)
                    agent.prompt(session, ["old prompt", "upgraded prompt", "rollback prompt"][index],
                                 ["old answer", "upgraded answer", "rollback answer"][index])
                rows = ledger(root)
                if index:
                    require(rows[:len(prefixes)] == prefixes, "upgrade/downgrade rewrote existing journal rows")
                    body = json.dumps(provider.calls[index])
                    require("old prompt" in body and "old answer" in body, "lost baseline history")
                if index == 2:
                    require("upgraded prompt" in body and "upgraded answer" in body, "rollback lost upgraded history")
                prefixes = rows
            require(len(provider.calls) == 3, "process replacement replayed provider work")
            return {"result": "PASS", "providerCalls": len(provider.calls), "retainedEvents": len(prefixes),
                    "checks": ["SQLite integrity", "unchanged journal prefixes", "history after upgrade and downgrade",
                               "no duplicate output on resume", "no repeated provider work"]}


def confinement(binary):
    results = []
    for outside in [False, True]:
        with tempfile.TemporaryDirectory(prefix="miao-confinement-drill-") as temporary:
            root = Path(temporary).resolve()
            prepare(root)
            sentinel = root / "sentinel.txt"
            sentinel.write_text("untouched", encoding="utf-8")
            if os.name == "nt":
                target = str(sentinel) if outside else "inside.txt"
                command = ["cmd", "/d", "/c", 'echo changed>"' + target + '"']
            else:
                # Pass the path as argv, not shell interpolation.
                command = ["/bin/sh", "-c", 'printf changed > "$1"', "artifact-drill", str(sentinel) if outside else "inside.txt"]
            with Fixture([sse(command=command), sse(text="process settled")]) as provider:
                with Agent(binary, root, provider.endpoint) as agent:
                    agent.prompt(agent.session(), "execute the declared process", "process settled")
                rows = ledger(root)
                require(any(kind == "tool.dispatched" for _, kind, _ in rows), "process was never dispatched")
                completed = [json.loads(data)["result"] for _, kind, data in rows if kind == "tool.completed"]
                require(len(completed) == 1, "expected exactly one completed process")
                process = completed[0]
                require("exit_code" in process, "process did not reach the guarded executable: " + json.dumps(process))
                if outside:
                    require(process["exit_code"] != 0, "outside write exited successfully")
                    require(sentinel.read_text(encoding="utf-8") == "untouched", "outside sentinel was modified")
                else:
                    require(process["exit_code"] == 0, "workspace control failed: " + json.dumps(process))
                    require((root / "workspace" / "inside.txt").read_text(encoding="utf-8").strip() == "changed", "workspace control did not write")
                results.append({"scenario": "outside-write-denied" if outside else "workspace-write-control", "result": "PASS",
                                "exitCode": process["exit_code"]})
    return {"checks": results, "scope": "workspace write allowed; outside write denied by the guarded process; network/PTY not tested"}


def identity(binary):
    return {"version": subprocess.check_output([str(binary), "--version"], text=True).strip(),
            "sha256": hashlib.sha256(binary.read_bytes()).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True, type=Path)
    parser.add_argument("--previous", required=True, type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    binary, previous = args.binary.resolve(), args.previous.resolve()
    report = {"platform": platform.system(), "architecture": platform.machine(),
              "previous": identity(previous), "binary": identity(binary),
              "compatibility": compatibility(previous, binary), "confinement": confinement(binary)}
    encoded = json.dumps(report, indent=2)
    if args.output:
        args.output.write_text(encoded + "\n", encoding="utf-8")
    print(encoded)
    print("ENGINE_ARTIFACT_DRILL=PASS")


if __name__ == "__main__":
    main()
