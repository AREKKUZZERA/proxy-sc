export function createMockReq({ method = "GET", query = {}, headers = {} } = {}) {
  return { method, query, headers };
}

export function createMockRes() {
  const headers = new Map();
  return {
    statusCode: 200,
    body: null,
    ended: false,
    headers,
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
    },
    getHeader(name) {
      return headers.get(String(name).toLowerCase());
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    end(payload = null) {
      this.body = payload;
      this.ended = true;
      return this;
    }
  };
}

export function createJsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}
