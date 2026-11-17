// FFmpeg reel: N stills (Ken Burns) + optional clips, crossfades, Poppins text overlay, end card.
// Output: 1080x1920, 30 fps, H.264 + AAC (silent track), faststart. Then validated with ffprobe.
import { readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { BRAND } from "./brand.js";
import { FONT_BOLD, resolveAsset } from "./deps.js";

const W = 1080, H = 1920, FPS = 30;
const SEG = 4; // seconds per segment
const XF = 0.5; // crossfade seconds
const END = 3; // end card seconds
const dir = process.argv[2] ?? "out/assets";
const outFile = process.argv[3] ?? "out/reel.mp4";
const font = resolveAsset(FONT_BOLD);

const inputs = readdirSync(dir).filter((f) => /\.(png|jpg|mp4)$/.test(f)).sort();
if (inputs.length === 0) throw new Error(`no inputs in ${dir}; run npm run assets`);
const captions = ["Hecho a mano", "Con mucho color", "Para vos", "Cada pieza es única", "Hipérbole de estilo", "Veky"];
const hex = (c: string) => "0x" + c.slice(1);

const args: string[] = ["-y", "-hide_banner", "-loglevel", "error"];
const parts: string[] = [];
const lens: number[] = [];
inputs.forEach((f, i) => {
  const isClip = f.endsWith(".mp4");
  if (isClip) args.push("-i", `${dir}/${f}`);
  else args.push("-loop", "1", "-framerate", String(FPS), "-t", String(SEG), "-i", `${dir}/${f}`);
  const cap = captions[i % captions.length]!;
  const text = `drawtext=fontfile=${font}:text='${cap}':expansion=none:fontsize=84:fontcolor=${hex(BRAND.verde)}:borderw=6:bordercolor=${hex(BRAND.lila)}:x=(w-text_w)/2:y=h*0.12`;
  const base = isClip
    ? `[${i}:v]trim=duration=${SEG},setpts=PTS-STARTPTS,scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS}`
    : `[${i}:v]scale=${W * 1.2}:${H * 1.2},zoompan=z='min(1+0.0010*on,1.2)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${SEG * FPS}:s=${W}x${H}:fps=${FPS}`;
  parts.push(`${base},${text},format=yuv420p,setsar=1[v${i}]`);
  lens.push(SEG);
});
// End card: lila background, wordmark + CTA.
const n = inputs.length;
parts.push(
  `color=c=${hex(BRAND.lila)}:s=${W}x${H}:d=${END}:r=${FPS},` +
    `drawtext=fontfile=${font}:text='Veky':fontsize=220:fontcolor=white:x=(w-text_w)/2:y=h*0.38,` +
    `drawtext=fontfile=${font}:text='Consultá por WhatsApp':expansion=none:fontsize=60:fontcolor=${hex(BRAND.verde)}:borderw=4:bordercolor=${hex(BRAND.lila)}:x=(w-text_w)/2:y=h*0.55,` +
    `format=yuv420p,setsar=1[v${n}]`,
);
lens.push(END);
// Chain xfade: offset_i = (sum of lengths of segments 0..i) - (i+1)*XF
let acc = "v0", sum = lens[0]!;
for (let i = 1; i <= n; i++) {
  const label = i === n ? "vout" : `x${i}`;
  parts.push(`[${acc}][v${i}]xfade=transition=fade:duration=${XF}:offset=${(sum - i * XF).toFixed(2)}[${label}]`);
  acc = label;
  sum += lens[i]!;
}
const total = sum - n * XF;
args.push(
  "-f", "lavfi", "-t", total.toFixed(2), "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
  "-filter_complex", parts.join(";"),
  "-map", "[vout]", "-map", `${n}:a`,
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-profile:v", "high", "-pix_fmt", "yuv420p", "-r", String(FPS),
  "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", outFile,
);
const t0 = performance.now();
const r = spawnSync("ffmpeg", args, { stdio: "inherit" });
const secs = (performance.now() - t0) / 1000;
if (r.status !== 0) { console.error("ffmpeg failed"); process.exit(1); }
console.log(`REEL_RENDER_SECONDS=${secs.toFixed(1)} expected_duration=${total.toFixed(1)}s file=${outFile} size=${(statSync(outFile).size / 1e6).toFixed(2)}MB`);

// ---- ffprobe validation against Instagram Reels specs ----
const probe = spawnSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", outFile], { encoding: "utf8" });
const j = JSON.parse(probe.stdout) as { format: { format_name: string; duration: string; size: string }; streams: Record<string, string>[] };
const v = j.streams.find((s) => s.codec_type === "video")!;
const a = j.streams.find((s) => s.codec_type === "audio");
const [fn, fd] = v.avg_frame_rate!.split("/").map(Number);
const fps = fn! / fd!;
const dur = Number(j.format.duration);
const sizeMB = Number(j.format.size) / 1e6;
const checks: [string, boolean, string][] = [
  ["container MP4", j.format.format_name.includes("mp4"), j.format.format_name],
  ["video H.264", v.codec_name === "h264", `${v.codec_name} ${v.profile} ${v.pix_fmt}`],
  ["audio AAC", a?.codec_name === "aac", `${a?.codec_name} ${a?.sample_rate}Hz ${a?.channels}ch`],
  ["9:16", Number(v.width) * 16 === Number(v.height) * 9, `${v.width}x${v.height}`],
  ["fps 23-60", fps >= 23 && fps <= 60, fps.toFixed(2)],
  ["size <= 300 MB", sizeMB <= 300, `${sizeMB.toFixed(2)} MB`],
  ["duration 3 s..15 min", dur >= 3 && dur <= 900, `${dur.toFixed(2)} s`],
];
console.log("--- ffprobe summary ---");
for (const s of j.streams) console.log(JSON.stringify({ i: s.index, type: s.codec_type, codec: s.codec_name, profile: s.profile, w: s.width, h: s.height, pix_fmt: s.pix_fmt, fps: s.avg_frame_rate, sr: s.sample_rate, ch: s.channels, br: s.bit_rate }));
console.log(JSON.stringify(j.format));
for (const [name, ok, val] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${val}`);
if (checks.some((c) => !c[1])) process.exit(1);
