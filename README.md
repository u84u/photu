# photu

**photu** (ફોટુ, Gujarati for *photo*) is a tiny shell-pipe language for image
manipulation, built on [libvips](https://www.libvips.org/) — the fast,
low-memory image engine.

```sh
photu read "photos/*.jpg" | photu resize 1600 | photu sharpen | photu write "out/{name}.webp" quality=80
```

Compare the ImageMagick incantation for the same job:

```sh
magick mogrify -path out -format webp -quality 80 -resize 1600x1600\> -unsharp 0x1 photos/*.jpg
```

One of these you can write from memory.

## Install

```sh
npm i -g photu     # then: photu ...
npx photu ...      # or try it without installing
```

Requires Node 22+. libvips ships prebuilt — nothing to compile.

## How it works

The pipe does not carry pixels. Each stage appends its operation to a small
JSON **plan**; only the final `write` stage executes the whole plan as a
single fused libvips pipeline, so pixels are decoded exactly once no matter
how many stages you chain. Run a partial pipeline through `photu explain` to
see the plan being built:

```sh
$ photu read "photos/*.jpg" | photu resize 800x600 fit=cover | photu explain
photu plan (protocol 1)
files (50):
  ...
ops (1):
  1. resize  width=800 height=600 fit="cover" upscale=false
```

Because the pipe is one line of plain JSON, pipelines work in every shell —
bash, zsh, PowerShell, cmd.

## Commands

| command | example | notes |
|---|---|---|
| `read` | `photu read "*.jpg"` | start a pipeline; panics if the glob matches nothing |
| `resize` | `resize 1600`, `resize 800x600 fit=cover` | never upscales unless you add `upscale` |
| `crop` | `crop 800x600`, `crop 512 gravity=northwest`, `crop 800x600+40+10` | cuts pixels, no scaling; `crop 512` means a square |
| `rotate` | `rotate 90`, `rotate -13.5 background=white` | EXIF orientation is always applied first |
| `flip` / `mirror` | | vertical / horizontal |
| `grayscale` | | |
| `adjust` | `adjust brightness=1.1 saturation=0.8 hue=30` | |
| `blur` / `sharpen` | `blur 2.5`, `sharpen` | optional sigma |
| `overlay` | `overlay logo.png gravity=southeast opacity=0.5` | watermarks |
| `pad` | `pad 20 color=white` | |
| `write` | `write "out/{name}.webp" quality=80` | executes the pipeline |

Output templates take `{name}` (source basename), `{ext}` (source extension —
`write "out/{name}.{ext}"` keeps each file's format), and `{i}` (1-based index).

Utilities: `photu info "<glob>"` (format, dimensions, size per file),
`photu formats` (what your installed libvips can read and write),
`photu explain` (pretty-print the plan on stdin).

## Formats

JPEG, PNG, WebP, GIF, TIFF, AVIF read/write; SVG read (rasterize). Run
`photu formats` for the authoritative list.

## Errors

photu panics loudly and early: bad arguments die before any pixels are
decoded, an empty glob is an error, output collisions are detected before
writing, and photu refuses to overwrite its own inputs. A failing stage
passes a structured error down the pipe, so the pipeline's exit code is
nonzero in every shell — no `pipefail` required. stdout carries plans and
nothing else, ever.

## Why

- **libvips** is dramatically faster and lighter than ImageMagick.
- **Readable one-liners** beat memorizing `-resize 800x800^ -gravity center -extent 800x800`.
- **A language small enough to fit in your head** — this README is the whole
  reference.

## License

MIT
