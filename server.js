const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;

const ADMIN_KEY =
  process.env.ADMIN_KEY || 'change-this-to-a-long-random-secret';

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || '';

const ROOT = __dirname;
const PUBLIC = ROOT;
const DATA = path.join(ROOT, 'data');

fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(path.join(PUBLIC, 'images'), { recursive: true });

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml'
};

function send(
  res,
  status,
  data,
  type = 'application/json; charset=utf-8'
) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store'
  });

  if (type.startsWith('application/json')) {
    res.end(JSON.stringify(data));
  } else {
    res.end(data);
  }
}

function body(req) {
  return new Promise((resolve, reject) => {
    let s = '';

    req.on('data', chunk => {
      s += chunk;

      if (s.length > 12 * 1024 * 1024) {
        req.destroy();
      }
    });

    req.on('end', () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch (e) {
        reject(e);
      }
    });

    req.on('error', reject);
  });
}

function isAdmin(req) {
  const key =
    req.headers['x-admin-key'] ||
    String(req.headers.authorization || '').replace(
      /^Bearer\s+/i,
      ''
    );

  if (!key) return false;

  const a = Buffer.from(String(key));
  const b = Buffer.from(String(ADMIN_KEY));

  return (
    a.length === b.length &&
    crypto.timingSafeEqual(a, b)
  );
}

function admin(req, res) {
  if (!isAdmin(req)) {
    send(res, 401, { error: 'Unauthorized' });
    return false;
  }

  return true;
}

/* =========================================================
   SUPABASE
   ========================================================= */

function supabaseHeaders(extra = {}) {
  return {
    apikey: SUPABASE_SECRET_KEY,
    Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
    ...extra
  };
}

async function supabaseRequest(endpoint, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    throw new Error(
      'SUPABASE_URL or SUPABASE_SECRET_KEY is not configured.'
    );
  }

  const response = await fetch(
    `${SUPABASE_URL}${endpoint}`,
    {
      ...options,
      headers: supabaseHeaders({
        'Content-Type': 'application/json',
        ...(options.headers || {})
      })
    }
  );

  const text = await response.text();

  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    const message =
      data?.message ||
      data?.error_description ||
      data?.error ||
      text ||
      `Supabase error ${response.status}`;

    throw new Error(message);
  }

  return data;
}

/* =========================================================
   PRODUCTS
   ========================================================= */

async function getProducts() {
  return await supabaseRequest(
    '/rest/v1/products?select=*&order=created_at.desc'
  );
}

async function getProduct(id) {
  const rows = await supabaseRequest(
    `/rest/v1/products?id=eq.${encodeURIComponent(id)}&select=*`
  );

  return rows[0] || null;
}

async function createProduct(product) {
  const rows = await supabaseRequest(
    '/rest/v1/products',
    {
      method: 'POST',
      headers: {
        Prefer: 'return=representation'
      },
      body: JSON.stringify(product)
    }
  );

  return rows[0];
}

async function updateProduct(id, values) {
  const rows = await supabaseRequest(
    `/rest/v1/products?id=eq.${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: {
        Prefer: 'return=representation'
      },
      body: JSON.stringify(values)
    }
  );

  return rows[0] || null;
}

async function deleteProduct(id) {
  await supabaseRequest(
    `/rest/v1/products?id=eq.${encodeURIComponent(id)}`,
    {
      method: 'DELETE'
    }
  );
}

/* =========================================================
   ROUTES
   ========================================================= */

async function route(req, res) {
  const u = new URL(
    req.url,
    `http://${req.headers.host || 'localhost'}`
  );

  const p = u.pathname;

  /* ---------------------------------------------------------
     PUBLIC PRODUCTS
     --------------------------------------------------------- */

  if (req.method === 'GET' && p === '/api/products') {
    try {
      const products = await getProducts();

      return send(
        res,
        200,
        Array.isArray(products)
          ? products.filter(x => x.active !== false)
          : []
      );
    } catch (e) {
      console.error('GET PRODUCTS ERROR:', e);
      return send(res, 500, {
        error: 'Could not load products.',
        details: e.message
      });
    }
  }

  /* ---------------------------------------------------------
     ADMIN - GET PRODUCTS
     --------------------------------------------------------- */

  if (
    p === '/api/admin/products' &&
    req.method === 'GET'
  ) {
    if (!admin(req, res)) return;

    try {
      const products = await getProducts();

      return send(res, 200, products);
    } catch (e) {
      console.error('ADMIN GET PRODUCTS ERROR:', e);

      return send(res, 500, {
        error: 'Could not load products.',
        details: e.message
      });
    }
  }

  /* ---------------------------------------------------------
     ADMIN - CREATE PRODUCT
     --------------------------------------------------------- */

  if (
    p === '/api/admin/products' &&
    req.method === 'POST'
  ) {
    if (!admin(req, res)) return;

    try {
      const b = await body(req);

      if (
        !b.name ||
        !b.description ||
        !b.price
      ) {
        return send(res, 400, {
          error:
            'Name, description and price are required.'
        });
      }

      const product = {
        name: String(b.name),
        description: String(b.description),
        price: String(b.price),
        images: Array.isArray(b.images)
          ? b.images
          : [],
        active: b.active !== false
      };

      const created = await createProduct(product);

      return send(res, 201, created);
    } catch (e) {
      console.error('CREATE PRODUCT ERROR:', e);

      return send(res, 500, {
        error: 'Could not create product.',
        details: e.message
      });
    }
  }

  /* ---------------------------------------------------------
     ADMIN - UPDATE PRODUCT
     --------------------------------------------------------- */

  if (
    p.startsWith('/api/admin/products/') &&
    req.method === 'PUT'
  ) {
    if (!admin(req, res)) return;

    try {
      const id = decodeURIComponent(
        p.split('/').pop()
      );

      const existing = await getProduct(id);

      if (!existing) {
        return send(res, 404, {
          error: 'Product not found.'
        });
      }

      const b = await body(req);

      const values = {};

      if (b.name !== undefined)
        values.name = String(b.name);

      if (b.description !== undefined)
        values.description = String(b.description);

      if (b.price !== undefined)
        values.price = String(b.price);

      if (b.images !== undefined) {
        values.images = Array.isArray(b.images)
          ? b.images
          : [];
      }

      if (b.active !== undefined) {
        values.active = Boolean(b.active);
      }

      const updated = await updateProduct(
        id,
        values
      );

      return send(res, 200, updated);
    } catch (e) {
      console.error('UPDATE PRODUCT ERROR:', e);

      return send(res, 500, {
        error: 'Could not update product.',
        details: e.message
      });
    }
  }

  /* ---------------------------------------------------------
     ADMIN - DELETE PRODUCT
     --------------------------------------------------------- */

  if (
    p.startsWith('/api/admin/products/') &&
    req.method === 'DELETE'
  ) {
    if (!admin(req, res)) return;

    try {
      const id = decodeURIComponent(
        p.split('/').pop()
      );

      const existing = await getProduct(id);

      if (!existing) {
        return send(res, 404, {
          error: 'Product not found.'
        });
      }

      await deleteProduct(id);

      res.writeHead(204);
      return res.end();
    } catch (e) {
      console.error('DELETE PRODUCT ERROR:', e);

      return send(res, 500, {
        error: 'Could not delete product.',
        details: e.message
      });
    }
  }

  /* ---------------------------------------------------------
     IMAGE UPLOAD
     
     This keeps the existing upload behavior so your current
     admin page continues working.
     --------------------------------------------------------- */

  if (
    p === '/api/admin/upload' &&
    req.method === 'POST'
  ) {
    if (!admin(req, res)) return;

    try {
      const b = await body(req);

      const files = Array.isArray(b.files)
        ? b.files
        : [];

      const out = [];

      for (const f of files.slice(0, 8)) {
        if (!f.data || !f.name) continue;

        const ext = path
          .extname(f.name)
          .toLowerCase();

        if (
          ![
            '.jpg',
            '.jpeg',
            '.png',
            '.webp',
            '.gif'
          ].includes(ext)
        ) {
          continue;
        }

        const base = path
          .basename(f.name, ext)
          .replace(/[^a-z0-9]+/gi, '-')
          .replace(/^-|-$/g, '')
          .toLowerCase() || 'product';

        const filename =
          `${Date.now()}-${crypto
            .randomBytes(3)
            .toString('hex')}-${base}${ext}`;

        const data = String(f.data).replace(
          /^data:image\/[^;]+;base64,/,
          ''
        );

        const filePath = path.join(
          PUBLIC,
          'images',
          filename
        );

        fs.writeFileSync(
          filePath,
          Buffer.from(data, 'base64')
        );

        out.push('/images/' + filename);
      }

      return send(res, 200, {
        files: out
      });
    } catch (e) {
      console.error('UPLOAD ERROR:', e);

      return send(res, 500, {
        error: 'Could not upload image.',
        details: e.message
      });
    }
  }

  /* ---------------------------------------------------------
     CHAT
     
     Kept compatible with the existing site.
     --------------------------------------------------------- */

  if (
    p === '/api/chat' &&
    req.method === 'POST'
  ) {
    try {
      const b = await body(req);

      if (
        !String(b.message || '').trim()
      ) {
        return send(res, 400, {
          error: 'Message is required.'
        });
      }

      const messagesFile = path.join(
        DATA,
        'messages.json'
      );

      let messages = [];

      try {
        messages = JSON.parse(
          fs.readFileSync(
            messagesFile,
            'utf8'
          )
        );
      } catch {
        messages = [];
      }

      const conversationId =
        b.conversationId ||
        crypto.randomUUID();

      messages.push({
        id: crypto.randomUUID(),
        conversationId,
        role: 'customer',
        name: String(
          b.name || 'Visitor'
        ).slice(0, 120),
        email: String(
          b.email || ''
        ).slice(0, 160),
        message: String(
          b.message
        ).trim().slice(0, 4000),
        createdAt:
          new Date().toISOString()
      });

      fs.writeFileSync(
        messagesFile,
        JSON.stringify(
          messages,
          null,
          2
        )
      );

      return send(res, 201, {
        conversationId
      });
    } catch (e) {
      console.error('CHAT ERROR:', e);

      return send(res, 500, {
        error: 'Could not save message.'
      });
    }
  }

  /* ---------------------------------------------------------
     GET CHAT CONVERSATION
     --------------------------------------------------------- */

  if (
    p.startsWith('/api/chat/') &&
    req.method === 'GET'
  ) {
    try {
      const cid = decodeURIComponent(
        p.split('/').pop()
      );

      const messagesFile = path.join(
        DATA,
        'messages.json'
      );

      let messages = [];

      try {
        messages = JSON.parse(
          fs.readFileSync(
            messagesFile,
            'utf8'
          )
        );
      } catch {
        messages = [];
      }

      return send(
        res,
        200,
        messages.filter(
          x =>
            x.conversationId === cid
        )
      );
    } catch (e) {
      console.error(
        'GET CHAT ERROR:',
        e
      );

      return send(res, 500, {
        error:
          'Could not load conversation.'
      });
    }
  }

  /* ---------------------------------------------------------
     ADMIN CHAT
     --------------------------------------------------------- */

  if (
    p === '/api/admin/chat' &&
    req.method === 'GET'
  ) {
    if (!admin(req, res)) return;

    try {
      const messagesFile = path.join(
        DATA,
        'messages.json'
      );

      let messages = [];

      try {
        messages = JSON.parse(
          fs.readFileSync(
            messagesFile,
            'utf8'
          )
        );
      } catch {
        messages = [];
      }

      const map = new Map();

      for (const m of messages) {
        if (!map.has(m.conversationId)) {
          map.set(
            m.conversationId,
            {
              conversationId:
                m.conversationId,
              name: m.name,
              email: m.email,
              updatedAt:
                m.createdAt,
              messages: []
            }
          );
        }

        const c = map.get(
          m.conversationId
        );

        c.messages.push(m);

        if (
          m.createdAt >
          c.updatedAt
        ) {
          c.updatedAt =
            m.createdAt;
        }
      }

      return send(
        res,
        200,
        [...map.values()].sort(
          (a, b) =>
            b.updatedAt.localeCompare(
              a.updatedAt
            )
        )
      );
    } catch (e) {
      console.error(
        'ADMIN CHAT ERROR:',
        e
      );

      return send(res, 500, {
        error:
          'Could not load chats.'
      });
    }
  }

  /* ---------------------------------------------------------
     ADMIN CHAT REPLY
     --------------------------------------------------------- */

  if (
    p.startsWith('/api/admin/chat/') &&
    req.method === 'POST'
  ) {
    if (!admin(req, res)) return;

    try {
      const cid = decodeURIComponent(
        p.split('/').pop()
      );

      const b = await body(req);

      const messagesFile = path.join(
        DATA,
        'messages.json'
      );

      let messages = [];

      try {
        messages = JSON.parse(
          fs.readFileSync(
            messagesFile,
            'utf8'
          )
        );
      } catch {
        messages = [];
      }

      if (
        !messages.some(
          x =>
            x.conversationId === cid
        )
      ) {
        return send(res, 404, {
          error:
            'Conversation not found.'
        });
      }

      if (
        !String(
          b.message || ''
        ).trim()
      ) {
        return send(res, 400, {
          error:
            'Message is required.'
        });
      }

      messages.push({
        id: crypto.randomUUID(),
        conversationId: cid,
        role: 'agent',
        name: 'H Wolf VW',
        email: 'hwolfvw@gmail.com',
        message: String(
          b.message
        ).trim().slice(0, 4000),
        createdAt:
          new Date().toISOString()
      });

      fs.writeFileSync(
        messagesFile,
        JSON.stringify(
          messages,
          null,
          2
        )
      );

      return send(res, 201, {
        ok: true
      });
    } catch (e) {
      console.error(
        'ADMIN CHAT REPLY ERROR:',
        e
      );

      return send(res, 500, {
        error:
          'Could not send reply.'
      });
    }
  }

  /* ---------------------------------------------------------
     STATIC FILES
     --------------------------------------------------------- */

  if (req.method === 'GET') {
    let file;

    if (p === '/admin') {
      file = path.join(
        PUBLIC,
        'admin.html'
      );
    } else {
      const requested =
        p === '/'
          ? '/index.html'
          : p;

      const full = path.normalize(
        path.join(
          PUBLIC,
          requested
        )
      );

      if (
        full.startsWith(
          PUBLIC + path.sep
        )
      ) {
        file = full;
      }
    }

    if (
      file &&
      fs.existsSync(file) &&
      fs.statSync(file).isFile()
    ) {
      const ext =
        path.extname(file);

      res.writeHead(200, {
        'Content-Type':
          mime[ext] ||
          'application/octet-stream'
      });

      return fs
        .createReadStream(file)
        .pipe(res);
    }

    if (!p.startsWith('/api/')) {
      const indexFile =
        path.join(
          PUBLIC,
          'index.html'
        );

      res.writeHead(200, {
        'Content-Type':
          mime['.html']
      });

      return fs
        .createReadStream(indexFile)
        .pipe(res);
    }
  }

  return send(res, 404, {
    error: 'Not found'
  });
}

/* =========================================================
   SERVER
   ========================================================= */

const server = http.createServer(
  (req, res) => {
    route(req, res).catch(error => {
      console.error(
        'SERVER ERROR:',
        error
      );

      send(res, 500, {
        error: 'Server error.',
        details: error.message
      });
    });
  }
);

server.listen(
  PORT,
  () => {
    console.log(
      `H Wolf VW running on port ${PORT}`
    );

    console.log(
      `Supabase configured: ${
        SUPABASE_URL ? 'YES' : 'NO'
      }`
    );
  }
);
