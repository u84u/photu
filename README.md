# photu

photu is a small command-line tool for batch image work. You build pipelines
out of ordinary shell pipes, and the whole thing runs as one
[libvips](https://www.libvips.org/) operation at the end, so it's fast and
uses very little memory.

```sh
photu read "photos/*.jpg" | photu resize 1600 | photu sharpen | photu write "out/{name}.webp" quality=80
```

The equivalent ImageMagick command is something like
`magick mogrify -path out -format webp -quality 80 -resize 1600x1600\> -unsharp 0x1 photos/*.jpg`,
which I have never once typed correctly from memory. That's more or less why
this exists.

photu (ફોટુ) is Gujarati slang for a photo.

You can try it in the browser at [tryphotu.vercel.app](https://tryphotu.vercel.app) —
the playground runs the same parser and the same libvips, compiled to
WebAssembly, and images stay on your machine.

## Install

```sh
npm i -g photu
```

Needs Node 22 or newer. libvips comes prebuilt with the sharp dependency, so
there is nothing to compile.

## How it works

The pipe between stages doesn't carry image data. Each stage appends its
operation to a small JSON plan and passes that along; the final `write` stage
hands the whole plan to libvips in one go. So you can chain as many stages as
you like and each image is still only decoded and encoded once.

You can look at the plan at any point by piping into `photu explain`:

```
$ photu read "photos/*.jpg" | photu resize 800x600 fit=cover | photu explain
photu plan (protocol 1)
files (50):
  ...
ops (1):
  1. resize  width=800 height=600 fit="cover" upscale=false
```

A side effect of the plan being plain text is that pipelines work the same in
bash, zsh, PowerShell and cmd.

## Speed

50 public-domain images from the Met Museum's Open Access collection (1,130px
to 4,000px on the long edge, 116 MB of JPEGs), resized to 800px wide and
written as WebP at quality 80. Measured with hyperfine on Windows 10, against
ImageMagick 7.1.2-27:

| | time |
|---|---|
| photu | 2.0 s |
| ImageMagick Q8 with `-define jpeg:size=1600x1200` | 12.6 s |
| ImageMagick Q8 | 22.2 s |
| ImageMagick Q16-HDRI (the default download) | 23.0 s |

The commands were `photu read "src/*.jpg" | photu resize 800 | photu write
"out/{name}.webp" quality=80` and `magick mogrify -path out -format webp
-quality 80 -resize 800 src/*.jpg`. The `jpeg:size` row is the fastest
ImageMagick configuration I could find. Most of the difference is libvips: it
decodes JPEGs at reduced scale where the pipeline allows it, and it threads
well. photu's time includes launching four Node processes.

## Stacking it up

Every stage is just another pipe, so there's no ceiling on how many you
chain. This resizes, crops to a fixed aspect ratio, nudges the framing,
punches the color, sharpens, drops in a watermark, adds a border and writes
WebP - eight stages, one libvips pass, still a single JSON plan changing
hands the whole way through:

```sh
photu read "photos/*.jpg" \
| photu resize 1600 \
| photu crop 1200x630 gravity=center \
| photu rotate -3 background=white \
| photu adjust saturation=1.3 hue=15 \
| photu sharpen \
| photu overlay logo.png gravity=southeast opacity=0.35 \
| photu pad 24 color=white \
| photu write "social/{name}.webp" quality=82
```

`read` isn't limited to local files, either - it takes `http(s)://` URLs
too, mixed freely with globs:

```sh
photu read "local/*.jpg" "https://example.com/hero.jpg" \
| photu resize 1600 \
| photu write "out/{name}.webp"
```

A URL only gets checked for valid syntax at `read` time; the actual fetch
happens later, per file, inside `write` - the same place and the same
worker pool that already decodes local files. The response is pulled
straight into memory and handed to libvips as a buffer, so a remote image
never touches disk and costs exactly one network round trip. Fetches are
capped at 50 MB and 15 seconds, and only `http`/`https` are supported.

## Isn't this just a libvips wrapper?

Yes. libvips does all the pixel work, and the speed above is libvips' speed.
What photu adds is the interface. The vips CLI runs one operation per
process, so chaining operations means writing intermediate files or pushing
raw pixels through the pipe; photu passes a plan instead and runs the whole
chain fused. It also adds globs, URL sources, output templates, overwrite and
collision guards, and an install that is one npm command on any OS. If `vipsthumbnail`
already covers your workflow, use it - it's excellent.

## Commands

| command | example | notes |
|---|---|---|
| `read` | `photu read "*.jpg"`, `photu read "*.jpg" "https://example.com/a.jpg"` | starts a pipeline from one or more globs and/or URLs. An empty glob is an error |
| `resize` | `resize 1600`, `resize 800x600 fit=cover` | won't upscale unless you add `upscale` |
| `crop` | `crop 800x600`, `crop 512 gravity=northwest`, `crop 800x600+40+10` | cuts pixels, never scales. `crop 512` is a square |
| `rotate` | `rotate 90`, `rotate -13.5 background=white` | EXIF orientation is applied automatically before anything else |
| `flip`, `mirror` | | vertical / horizontal |
| `grayscale` | | |
| `adjust` | `adjust brightness=1.1 saturation=0.8 hue=30` | |
| `blur`, `sharpen` | `blur 2.5`, `sharpen` | sigma is optional |
| `overlay` | `overlay logo.png gravity=southeast opacity=0.5` | for watermarks |
| `pad` | `pad 20 color=white` | |
| `write` | `write "out/{name}.webp" quality=80` | runs the pipeline |

Output templates understand `{name}` (source filename without extension),
`{ext}` (source extension, so `write "out/{name}.{ext}"` keeps each file's
format) and `{i}` (1-based index).

There are also three utilities that aren't pipeline stages:

- `photu info "<glob>"` prints format, dimensions and size for each file
- `photu formats` lists what your installed libvips can read and write
- `photu explain` pretty-prints whatever plan arrives on stdin

## Formats

JPEG, PNG, WebP, GIF, TIFF and AVIF, read and write. SVG can be read (it gets
rasterized). `photu formats` gives the authoritative list for your install.

## Error handling

photu tries hard to fail before touching any pixels: bad arguments, empty
globs, malformed URLs, output filename collisions and attempts to overwrite
an input file are all caught up front. What a URL actually points to isn't
one of those checks - a dead link or a timeout can only be discovered at
`write` time, the same as a corrupt local file, and fails the whole batch
the same way a corrupt local file does. When a stage in the middle of a
pipeline fails, it passes a structured error down the pipe instead of
pixels, so the pipeline exits nonzero in any shell without needing
`pipefail`. stdout is reserved for plans; everything human-readable goes to
stderr.

## License

MIT
