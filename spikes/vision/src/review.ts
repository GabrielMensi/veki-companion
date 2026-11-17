// Builds out/review.md (gitignored) from out/raw-*.json so a human can judge quality by eye.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "out");
let md = "# Review (private, gitignored)\n\nFrames are in `out/frames/`. Judge the picks and captions by eye.\n";
for (const f of readdirSync(out).filter((x) => x.startsWith("raw-")).sort()) {
  const { results } = JSON.parse(readFileSync(join(out, f), "utf8"));
  md += `\n## ${f}\n`;
  for (const [k, v] of Object.entries<any>(results)) {
    const [prov, video, task, run] = k.split("|");
    if (task === "rank") {
      md += `\n### ${video} run ${run}: ranking (${prov})\nFrames offered: ${v.files.join(", ")}\n`;
      if (!v.rank) md += "- FAILED\n";
      for (const b of v.rank?.best ?? []) md += `- ${b.file}: ${b.reason}\n`;
    } else {
      md += `\n#### ${video} run ${run}: description of ${v.file}\n`;
      if (!v.desc) { md += "- FAILED\n"; continue; }
      const d = v.desc;
      md += `- type: ${d.product_type}\n- colors: ${d.colors.join(", ")}\n- pattern/material: ${d.pattern_or_material}\n- use: ${d.probable_use}\n- caption: ${d.caption_es}\n- alt: ${d.alt_text_es}\n`;
    }
  }
}
writeFileSync(join(out, "review.md"), md);
console.log("wrote out/review.md");
