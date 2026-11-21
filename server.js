require("dotenv").config();
const express = require("express");
const path = require("path");
const mysql = require("mysql2/promise");
const session = require("express-session");
const bcrypt = require("bcrypt");

let compression = null;
try { compression = require("compression"); } catch (e) { /* optional: npm i compression */ }

const app = express();
const PORT = process.env.PORT || 3000;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
if (process.env.TRUST_PROXY) app.set("trust proxy", 1);

if (compression) app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    dateStrings: true
});

app.use(session({
    secret: process.env.SESSION_SECRET || "change-this-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: process.env.COOKIE_SECURE === "1",
        sameSite: "lax",
        maxAge: 8 * 60 * 60 * 1000
    }
}));

/* =========================================================
   CONFIG
   event_id: 1 = activation | 2 = deactivation | 3 = renewal
   ========================================================= */
const TABLE = "hutch_new_portals.hutch_callback_logs";

const SERVICES = [
    { id: 1235, key: "yumzzy",   name: "Yumzzy",   letter: "Y", color: "#f97316" },
    { id: 1237, key: "eduwav",   name: "Eduwav",   letter: "E", color: "#3b82f6" },
    { id: 1305, key: "fitai",    name: "FITAI",    letter: "F", color: "#14b8a6" },
    { id: 1307, key: "radiofyy", name: "Radiofyy", letter: "R", color: "#ec4899" }
];
const SERVICE_BY_ID = Object.fromEntries(SERVICES.map(s => [s.id, s]));

/* =========================================================
   HELPERS (all local-time safe, no toISOString shifts)
   ========================================================= */
const pad = n => String(n).padStart(2, "0");
const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function addDays(str, n) {
    const [y, m, d] = str.split("-").map(Number);
    return fmt(new Date(y, m - 1, d + n));
}

const validDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && addDays(s, 0) === s;

function fillDates(from, to) {
    const out = [];
    for (let d = from; d <= to && out.length < 400; d = addDays(d, 1)) out.push(d);
    return out;
}

const r2 = n => Number((Number(n) || 0).toFixed(2));
const r0 = n => Math.round(Number(n) || 0);

/* =========================================================
   IN-MEMORY CACHE (+ in-flight de-duplication)
   ========================================================= */
const cache = new Map();

async function memo(key, ttlMs, fn) {
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && hit.exp > now) return { value: await hit.p, hit: true };

    const p = fn();
    cache.set(key, { p, exp: now + ttlMs });
    p.catch(() => cache.delete(key));

    if (cache.size > 500) {
        for (const [k, v] of cache) if (v.exp < now) cache.delete(k);
        if (cache.size > 500) cache.clear();
    }
    return { value: await p, hit: false };
}

/* =========================================================
   QUERIES (index-friendly, one pass each)
   ========================================================= */
const marks = ids => ids.map(() => "?").join(",");

// Day x bundle aggregates for a [from, toExclusive) range
async function fetchDaily(ids, from, toExcl) {
    const [rows] = await pool.execute(`
        SELECT
            DATE(createdAt) AS d,
            bundle_id,
            SUM(event_id = 1)                                AS act,
            SUM(event_id = 1 AND charge_result = 1)          AS paid,
            SUM(event_id = 3)                                AS ren,
            SUM(event_id = 2)                                AS deact,
            SUM(CASE WHEN event_id IN (1,3) THEN amount ELSE 0 END) AS amt
        FROM ${TABLE}
        WHERE bundle_id IN (${marks(ids)})
          AND event_id IN (1,2,3)
          AND createdAt >= ?
          AND createdAt < ?
        GROUP BY d, bundle_id
    `, [...ids, `${from} 00:00:00`, `${toExcl} 00:00:00`]);

    return rows.map(r => ({
        d: r.d,
        id: Number(r.bundle_id),
        act: Number(r.act) || 0,
        paid: Number(r.paid) || 0,
        ren: Number(r.ren) || 0,
        deact: Number(r.deact) || 0,
        amt: Number(r.amt) || 0
    }));
}

// Net active base (activations - deactivations) per bundle before a date
async function fetchBase(ids, before) {
    const [rows] = await pool.execute(`
        SELECT
            bundle_id,
            SUM(event_id = 1) AS a,
            SUM(event_id = 2) AS x
        FROM ${TABLE}
        WHERE bundle_id IN (${marks(ids)})
          AND event_id IN (1,2)
          AND createdAt < ?
        GROUP BY bundle_id
    `, [...ids, `${before} 00:00:00`]);

    const map = {};
    ids.forEach(id => (map[id] = 0));
    rows.forEach(r => (map[Number(r.bundle_id)] = (Number(r.a) || 0) - (Number(r.x) || 0)));
    return map;
}

/* =========================================================
   MONTHLY PROJECTION
   projected = month-to-date + (last 7 completed days avg) x days left
   ========================================================= */
function buildProjection(selected, todayStr, rows, openingBase) {
    const [y, m] = todayStr.split("-").map(Number);
    const dayOfMonth = Number(todayStr.slice(8));
    const daysInMonth = new Date(y, m, 0).getDate();
    const remaining = daysInMonth - dayOfMonth;
    const monthStart = `${todayStr.slice(0, 8)}01`;
    const dates = fillDates(monthStart, todayStr);

    const idx = {};
    rows.forEach(r => (idx[`${r.id}|${r.d}`] = r));

    const calc = (vals) => {
        const mtd = vals.reduce((a, b) => a + b, 0);
        const done = vals.slice(0, -1).slice(-7);
        const avg = done.length ? done.reduce((a, b) => a + b, 0) / done.length : mtd / Math.max(dayOfMonth, 1);
        return { mtd, avg, projected: mtd + avg * remaining };
    };

    const out = { revenue: 0, mtdRevenue: 0, avgRevenue: 0, act: 0, mtdAct: 0, deact: 0, mtdDeact: 0, base: 0, baseNow: 0 };
    const services = [];

    selected.forEach(s => {
        const get = f => dates.map(d => (idx[`${s.id}|${d}`] ? idx[`${s.id}|${d}`][f] : 0));
        const rev = calc(get("amt"));
        const act = calc(get("act"));
        const dea = calc(get("deact"));
        const baseNow = (openingBase[s.id] || 0) + act.mtd - dea.mtd;

        out.revenue += rev.projected; out.mtdRevenue += rev.mtd; out.avgRevenue += rev.avg;
        out.act += act.projected; out.mtdAct += act.mtd;
        out.deact += dea.projected; out.mtdDeact += dea.mtd;
        out.baseNow += baseNow;
        out.base += baseNow + (act.avg - dea.avg) * remaining;

        services.push({ key: s.key, name: s.name, color: s.color, mtd: r2(rev.mtd), projected: r2(rev.projected) });
    });

    return {
        month: new Date(y, m - 1, 1).toLocaleString("en-IN", { month: "long", year: "numeric" }),
        dayOfMonth, daysInMonth, remaining,
        revenue: { mtd: r2(out.mtdRevenue), avgDaily: r2(out.avgRevenue), projected: r2(out.revenue) },
        activations: { mtd: r0(out.mtdAct), projected: r0(out.act) },
        deactivations: { mtd: r0(out.mtdDeact), projected: r0(out.deact) },
        activeBase: { current: r0(out.baseNow), projected: r0(out.base) },
        services
    };
}

/* =========================================================
   AUTH
   ========================================================= */
function requireLogin(req, res, next) {
    if (req.session && req.session.user) return next();
    if (req.originalUrl.startsWith("/api/")) {
        return res.status(401).json({ success: false, message: "Unauthorized. Please login." });
    }
    return res.redirect("/login");
}

app.get("/login", (req, res) => {
    if (req.session.user) return res.redirect("/");
    res.render("login", { error: null });
});

app.post("/login", async (req, res) => {
    try {
        const username = String(req.body.username || "").trim().toLowerCase();
        const password = String(req.body.password || "");
        if (!username || !password) {
            return res.render("login", { error: "Username and password are required." });
        }

        const [users] = await pool.execute(
            `SELECT id, username, password, role, status FROM dashboard_users WHERE username = ? LIMIT 1`,
            [username]
        );
        if (!users.length) {
            return res.render("login", { error: "Invalid username or password." });
        }

        const user = users[0];
        if (Number(user.status) !== 1) {
            return res.render("login", { error: "Your account has been disabled." });
        }

        const valid = await bcrypt.compare(password, user.password);
        if (!valid) {
            return res.render("login", { error: "Invalid username or password." });
        }

        req.session.regenerate(err => {
            if (err) {
                console.error(err);
                return res.render("login", { error: "Unable to create login session." });
            }
            req.session.user = { id: user.id, username: user.username, role: user.role };
            req.session.save(saveErr => {
                if (saveErr) {
                    console.error(saveErr);
                    return res.render("login", { error: "Unable to save session." });
                }
                res.redirect("/");
            });
        });
    } catch (error) {
        console.error("LOGIN ERROR:", error);
        res.status(500).render("login", { error: "Server error. Please try again." });
    }
});

app.post("/logout", (req, res) => {
    req.session.destroy(err => {
        if (err) {
            console.error(err);
            return res.status(500).send("Logout failed");
        }
        res.clearCookie("connect.sid");
        res.redirect("/login");
    });
});

/* =========================================================
   DASHBOARD PAGE
   ========================================================= */
app.get("/", requireLogin, (req, res) => {
    const today = new Date();
    const endDate = fmt(today);
    const startDate = fmt(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6));

    res.render("dashboard", {
        user: req.session.user,
        startDate,
        endDate,
        services: SERVICES.map(({ id, ...s }) => s)
    });
});

/* =========================================================
   REVENUE API
   ========================================================= */
app.get("/api/revenue", requireLogin, async (req, res) => {
    const t0 = process.hrtime.bigint();

    try {
        const todayStr = fmt(new Date());
        const monthStart = `${todayStr.slice(0, 8)}01`;

        const startDate = String(req.query.startDate || monthStart);
        const endDate = String(req.query.endDate || todayStr);

        if (!validDate(startDate) || !validDate(endDate)) {
            return res.status(400).json({ success: false, message: "Invalid date format. Use YYYY-MM-DD." });
        }
        if (startDate > endDate) {
            return res.status(400).json({ success: false, message: "Start date cannot be greater than end date." });
        }

        const dates = fillDates(startDate, endDate);
        if (dates.length > 366) {
            return res.status(400).json({ success: false, message: "Date range cannot exceed 366 days." });
        }

        const serviceKey = String(req.query.service || "all").toLowerCase();
        const selected = serviceKey === "all" ? SERVICES : SERVICES.filter(s => s.key === serviceKey);
        if (!selected.length) {
            return res.status(400).json({ success: false, message: "Unknown service." });
        }

        const ids = selected.map(s => s.id);
        const idKey = ids.join(",");
        const endExcl = addDays(endDate, 1);
        const tomorrow = addDays(todayStr, 1);

        // Ranges that include today refresh every 60s, history is cached for 10 min
        const ttl = endExcl > todayStr ? 60 * 1000 : 10 * 60 * 1000;

        const [daily, opening, mDaily, mOpening] = await Promise.all([
            memo(`d|${idKey}|${startDate}|${endExcl}`, ttl, () => fetchDaily(ids, startDate, endExcl)),
            memo(`b|${idKey}|${startDate}`, 5 * 60 * 1000, () => fetchBase(ids, startDate)),
            memo(`d|${idKey}|${monthStart}|${tomorrow}`, 60 * 1000, () => fetchDaily(ids, monthStart, tomorrow)),
            memo(`b|${idKey}|${monthStart}`, 5 * 60 * 1000, () => fetchBase(ids, monthStart))
        ]);

        const rows = daily.value;
        const openingBase = opening.value;

        /* ---------- aggregate ---------- */
        const dayMap = {};
        dates.forEach(d => (dayMap[d] = { date: d, revenue: 0, activations: 0, paidActivations: 0, renewals: 0, deactivations: 0 }));

        const svcMap = {};
        selected.forEach(s => (svcMap[s.id] = {
            key: s.key, service: s.name, letter: s.letter, color: s.color,
            revenue: 0, activations: 0, paidActivations: 0, renewals: 0, deactivations: 0
        }));

        rows.forEach(r => {
            const day = dayMap[r.d];
            const svc = svcMap[r.id];
            if (!day || !svc) return;

            day.revenue += r.amt; day.activations += r.act; day.paidActivations += r.paid;
            day.renewals += r.ren; day.deactivations += r.deact;

            svc.revenue += r.amt; svc.activations += r.act; svc.paidActivations += r.paid;
            svc.renewals += r.ren; svc.deactivations += r.deact;
        });

        const totalOpening = Object.values(openingBase).reduce((a, b) => a + b, 0);
        let running = totalOpening;

        const dailyData = dates.map(d => {
            const x = dayMap[d];
            const net = x.activations - x.deactivations;
            running += net;
            return {
                date: d,
                revenue: r2(x.revenue),
                activations: x.activations,
                paidActivations: x.paidActivations,
                renewals: x.renewals,
                deactivations: x.deactivations,
                netAdds: net,
                transactions: x.activations + x.renewals,
                activeBase: running
            };
        });

        const sum = f => dailyData.reduce((a, b) => a + b[f], 0);
        const totalRevenue = r2(sum("revenue"));

        const services = Object.values(svcMap).map(s => {
            const id = selected.find(x => x.key === s.key).id;
            const net = s.activations - s.deactivations;
            return {
                ...s,
                revenue: r2(s.revenue),
                transactions: s.activations + s.renewals,
                netAdds: net,
                activeBase: (openingBase[id] || 0) + net,
                percentage: totalRevenue > 0 ? (s.revenue / totalRevenue) * 100 : 0
            };
        });

        const details = rows
            .map(r => ({
                report_date: r.d,
                service: SERVICE_BY_ID[r.id].name,
                key: SERVICE_BY_ID[r.id].key,
                bundle_id: r.id,
                activations: r.act,
                paid_activations: r.paid,
                renewals: r.ren,
                deactivations: r.deact,
                total_transactions: r.act + r.ren,
                total_amount: r2(r.amt)
            }))
            .sort((a, b) => (a.report_date < b.report_date ? 1 : a.report_date > b.report_date ? -1 : a.bundle_id - b.bundle_id));

        const summary = {
            totalRevenue,
            totalActivations: sum("activations"),
            totalPaidActivations: sum("paidActivations"),
            totalRenewals: sum("renewals"),
            totalDeactivations: sum("deactivations"),
            totalTransactions: sum("transactions"),
            netAdds: sum("netAdds"),
            openingBase: totalOpening,
            activeBase: running
        };

        const projection = buildProjection(selected, todayStr, mDaily.value, mOpening.value);
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;

        return res.json({
            success: true,
            filters: { startDate, endDate, service: serviceKey },
            summary,
            services,
            dailyData,
            details,
            projection,
            perf: {
                ms: Number(ms.toFixed(1)),
                cached: daily.hit && opening.hit && mDaily.hit && mOpening.hit
            }
        });
    } catch (error) {
        console.error("REVENUE API ERROR:", error);
        return res.status(500).json({ success: false, message: "Unable to fetch revenue data." });
    }
});

/* =========================================================
   DATABASE INIT
   ========================================================= */
async function initializeDatabase() {
    try {
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS dashboard_users (
                id INT UNSIGNED NOT NULL AUTO_INCREMENT,
                username VARCHAR(100) NOT NULL UNIQUE,
                password VARCHAR(255) NOT NULL,
                role VARCHAR(30) NOT NULL DEFAULT 'admin',
                status TINYINT(1) NOT NULL DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id)
            )
        `);

        const [users] = await pool.execute(
            `SELECT id FROM dashboard_users WHERE username = ? LIMIT 1`, ["admin"]
        );

        if (!users.length) {
            const hashedPassword = await bcrypt.hash("Admin@123", 12);
            await pool.execute(
                `INSERT INTO dashboard_users (username, password, role, status) VALUES (?, ?, 'admin', 1)`,
                ["admin", hashedPassword]
            );
            console.log("Default admin created. Username: admin | Password: Admin@123 (change it!)");
        }
    } catch (error) {
        console.error("DATABASE INITIALIZATION ERROR:", error);
        process.exit(1);
    }
}

/*
 * COVERING INDEX - this is what makes the report run in milliseconds.
 * Run once manually (recommended) or start the app with AUTO_INDEX=1:
 *
 *   ALTER TABLE hutch_new_portals.hutch_callback_logs
 *   ADD INDEX idx_dash_report (bundle_id, event_id, createdAt, charge_result, amount);
 */
async function ensureIndex() {
    if (process.env.AUTO_INDEX !== "1") {
        console.log("Tip: add covering index idx_dash_report (see comment in server.js) for millisecond queries.");
        return;
    }
    try {
        const [exists] = await pool.execute(`
            SELECT 1 FROM information_schema.statistics
            WHERE table_schema = 'hutch_new_portals'
              AND table_name = 'hutch_callback_logs'
              AND index_name = 'idx_dash_report' LIMIT 1
        `);
        if (exists.length) return;
        console.log("Creating index idx_dash_report in background...");
        await pool.query(`
            ALTER TABLE ${TABLE}
            ADD INDEX idx_dash_report (bundle_id, event_id, createdAt, charge_result, amount)
        `);
        console.log("Index idx_dash_report created.");
    } catch (error) {
        console.error("INDEX ERROR (non-fatal):", error.message);
    }
}

async function startServer() {
    try {
        const connection = await pool.getConnection();
        console.log("MySQL connected:", process.env.DB_NAME);
        connection.release();

        await initializeDatabase();

        app.listen(PORT, () => {
            console.log(`Dashboard: http://localhost:${PORT}`);
            ensureIndex();
        });
    } catch (error) {
        console.error("SERVER START ERROR:", error.message);
        process.exit(1);
    }
}

startServer();