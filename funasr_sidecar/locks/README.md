# FunASR runtime locks

CalMee's first-use installer selects a reviewed target lock. The matching lock
pins every Python dependency and distribution hash for CPython 3.11.15. An
unsupported platform is blocked before any download.

| Runtime key | Build host | Lock file |
| --- | --- | --- |
| `darwin-arm64` | macOS Apple silicon | `darwin-arm64.lock` |
| `linux-x64` | Linux x86-64 (glibc) | `linux-x64.lock` |
| `win32-x64` | Windows x86-64 | `win32-x64.lock` |

Regenerate all locks only as an intentional dependency update:

```bash
node scripts/lock-funasr-runtime.mjs
```

Review the changed versions and hashes, run the target-native fresh-build
check, and commit the input and all generated locks together. Model weights are
not part of these locks or the packaged runtime.

The installed FunASR/PyTorch runtime currently supports Apple-silicon macOS and
x86-64 Windows/Linux. PyTorch 2.11 does not publish a macOS Intel wheel, so an
Intel macOS release must fail instead of silently compiling or using a system
Python.
