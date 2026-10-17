const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".prbm": "application/octet-stream",
  ".gz": "application/gzip",
};

export default {
  async fetch(request, env) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { allow: "GET, HEAD" },
      });
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response("Bad request", { status: 400 });
    }

    const segments = pathname.split("/").filter(Boolean);
    if (segments.some((part) => part === "." || part === ".." || part.includes("\0"))) {
      return new Response("Bad request", { status: 400 });
    }

    let key = segments.join("/");
    if (!key || pathname.endsWith("/")) key = key ? key + "/index.html" : "index.html";

    try {
      const object = await env.BLUEMAP.get(key);
      if (!object) return new Response("Not found", { status: 404 });

      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      headers.set("x-content-type-options", "nosniff");

      if (!headers.has("content-type")) {
        const dot = key.lastIndexOf(".");
        const extension = dot >= 0 ? key.slice(dot).toLowerCase() : "";
        headers.set("content-type", MIME_TYPES[extension] || "application/octet-stream");
      }

      headers.set(
        "cache-control",
        key === "index.html" || key === "settings.json"
          ? "public, max-age=60, must-revalidate"
          : "public, max-age=300",
      );

      return new Response(request.method === "HEAD" ? null : object.body, {
        status: 200,
        headers,
      });
    } catch {
      return new Response("Map temporarily unavailable", { status: 503 });
    }
  },
};
