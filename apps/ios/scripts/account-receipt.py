"""Read only the native probe's sanitized, atomic completion receipt."""
import json
from pathlib import Path
import sys

STAGES = {"notStarted", "fixture", "login", "directory", "keychain", "pushRegistration", "pushContext", "pushRevocation", "denyDevice", "refreshRuntime", "rpc", "secondConnection", "logout", "disconnect", "cleared"}


def read_receipt(path):
    if not path.exists():
        return None
    value = json.loads(path.read_text())
    if (
        not isinstance(value, dict)
        or not isinstance(value.get("stage"), str)
        or value.get("stage") not in STAGES
        or type(value.get("finished")) is not bool
        or type(value.get("nativeAccount")) is not bool
        or (value["nativeAccount"] and value["stage"] != "cleared")
    ):
        raise ValueError("Invalid native account receipt")
    return value


if __name__ == "__main__":
    receipt = read_receipt(Path(sys.argv[1]))
    timeout = "--timeout" in sys.argv[2:]
    if not timeout and (receipt is None or not receipt["finished"]):
        sys.exit(2)
    print("NativeAccountStage:" + (receipt["stage"] if receipt else "notStarted"))
    if receipt and receipt["finished"] and receipt["nativeAccount"]:
        print('{"nativeAccount":true}')
        sys.exit(0)
    print("Native account integration failed")
    sys.exit(1)
