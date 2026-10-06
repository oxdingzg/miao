#!/usr/bin/env python3
"""Point an ELF's PT_INTERP at a longer path without moving a single byte.

`bun build --compile` clones the running bun and reuses its ELF layout, so the
template has to stay byte-identical to the GitHub release artifact. Anything
that relocates content -- patchelf growing the file by a page, objcopy
reshuffling sections into a new order, strip rewriting the section table --
makes the compiled binary segfault before `main`. That rules out
`patchelf --set-interpreter` and `autoPatchelfHook` for both the template and
the compiled binary.

The interpreter string lives in a `.interp` section in the ELF header area,
and there is slack between it and the next section that matters. Writing the
store's (much longer) interpreter path into that slack in place leaves the file
the same size and keeps every other byte where bun left it. Only two things
change: the string itself, and the `p_filesz` that bounds it -- the kernel
copies exactly that many bytes out and requires the last one to be NUL.
"""

import struct
import sys

path, new_interpreter = sys.argv[1], sys.argv[2]
blob = bytearray(open(path, "rb").read())
if blob[:4] != b"\x7fELF" or blob[4] != 2:
    sys.exit(f"{path}: not a 64-bit ELF")

e_phoff = struct.unpack_from("<Q", blob, 0x20)[0]
e_phentsize = struct.unpack_from("<H", blob, 0x36)[0]
e_phnum = struct.unpack_from("<H", blob, 0x38)[0]
e_shoff = struct.unpack_from("<Q", blob, 0x28)[0]
e_shentsize = struct.unpack_from("<H", blob, 0x3A)[0]
e_shnum = struct.unpack_from("<H", blob, 0x3C)[0]
e_shstrndx = struct.unpack_from("<H", blob, 0x3E)[0]

interp = next(
    header
    for header in (e_phoff + i * e_phentsize for i in range(e_phnum))
    if struct.unpack_from("<I", blob, header)[0] == 3  # PT_INTERP
)
offset = struct.unpack_from("<Q", blob, interp + 0x08)[0]
size = len(new_interpreter) + 1

shstr = struct.unpack_from("<Q", blob, e_shoff + e_shstrndx * e_shentsize + 0x18)[0]
sections = []
for i in range(e_shnum):
    header = e_shoff + i * e_shentsize
    name_at = struct.unpack_from("<I", blob, header)[0]
    name = blob[shstr + name_at:blob.index(b"\0", shstr + name_at)].decode()
    sections.append((name, header, struct.unpack_from("<Q", blob, header + 0x18)[0]))

# The bytes after .interp are ELF notes, which nothing reads at load time, so
# the string may run over them. Stop at the first section that is actually used.
limit = min(
    at
    for name, _, at in sections
    if at > offset and not name.startswith(".note")
)
if offset + size > limit:
    sys.exit(f"{path}: {size} bytes do not fit before {limit:#x}")

blob[offset:offset + size] = new_interpreter.encode() + b"\0"
struct.pack_into("<Q", blob, interp + 0x20, size)
for name, header, at in sections:
    if name == ".interp" and at == offset:
        struct.pack_into("<Q", blob, header + 0x20, size)

open(path, "wb").write(blob)
print(f"{path}: interpreter -> {new_interpreter}")
