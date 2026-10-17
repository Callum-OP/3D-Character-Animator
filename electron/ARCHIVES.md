# Archives: .zip and .rar

Models are often downloaded as an archive — a zip of folders, a `.rar` of textures, a zip
containing another zip. `src/three/modelBundle.js` (`readArchive`) opens them:

* The format is recognised from the file's own bytes, not its name.
* Archives inside archives are opened too (3 levels deep, size-capped).
* **zip** — read with fflate (bundled with three.js).
* **rar** (RAR 4 and RAR 5) — read with [`node-unrar-js`](https://github.com/YuJianrong/node-unrar.js)
  (MIT), which is the official UnRAR source compiled to WebAssembly. It runs in the renderer, so
  the browser build and the desktop app both support it, and the ~200 KB module is only
  downloaded when a `.rar` is actually opened (`src/three/archive.js`).

Not supported: password-protected archives and multi-part (`.part1.rar`) archives — both give a
clear message.

## Licensing notes (not legal advice)

UnRAR's license allows anyone to use its source to *extract* RAR archives, but not to create a
RAR compressor or re-create the RAR algorithm. This app only extracts. Keep the notice that
ships in `node_modules/node-unrar-js/` (its license files) with any distribution that includes
the library; `npm` normally does that for you via the bundled license text.
