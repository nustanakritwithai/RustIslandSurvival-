import fs from "fs";
import path from "path";

export function servePatchedIndex(publicDir) {
  return function patchedIndex(_req, res, next) {
    fs.readFile(path.join(publicDir, "index.html"), "utf8", (err, html) => {
      if (err) return next(err);
      const tag = '<script src="/thai_weapon_patch.js?v=1"></script>';
      const bodyEnd = "</body>";
      const out = html.includes(bodyEnd) ? html.replace(bodyEnd, `${tag}\n${bodyEnd}`) : `${html}\n${tag}`;
      res.type("html").send(out);
    });
  };
}
