require("dotenv").config();

const express = require("express");
const path = require("path");
const mysql = require("mysql2/promise");
const session = require("express-session");
const bcrypt = require("bcrypt");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

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
        secure: false,
        sameSite: "lax",
        maxAge: 8 * 60 * 60 * 1000
    }
}));

function requireLogin(req, res, next) {
    if (req.session && req.session.user) return next();

    if (req.originalUrl.startsWith("/api/")) {
        return res.status(401).json({
            success: false,
            message: "Unauthorized. Please login."
        });
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
            return res.render("login", {
                error: "Username and password are required."
            });
        }

        const [users] = await pool.execute(`
            SELECT id, username, password, role, status
            FROM dashboard_users
            WHERE username = ?
            LIMIT 1
        `, [username]);

        if (!users.length) {
            return res.render("login", {
                error: "Invalid username or password."
            });
        }

        const user = users[0];

        if (Number(user.status) !== 1) {
            return res.render("login", {
                error: "Your account has been disabled."
            });
        }

        const valid = await bcrypt.compare(password, user.password);

        if (!valid) {
            return res.render("login", {
                error: "Invalid username or password."
            });
        }

        req.session.regenerate(err => {
            if (err) {
                console.error(err);
                return res.render("login", {
                    error: "Unable to create login session."
                });
            }

            req.session.user = {
                id: user.id,
                username: user.username,
                role: user.role
            };

            req.session.save(saveErr => {
                if (saveErr) {
                    console.error(saveErr);
                    return res.render("login", {
                        error: "Unable to save session."
                    });
                }

                res.redirect("/");
            });
        });
    } catch (error) {
        console.error("LOGIN ERROR:", error);
        res.status(500).render("login", {
            error: "Server error. Please try again."
        });
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

app.get("/", requireLogin, (req, res) => {
    const today = new Date();
    const endDate = today.toISOString().substring(0, 10);

    const start = new Date(today);
    start.setDate(start.getDate() - 6);

    const startDate = start.toISOString().substring(0, 10);

    res.render("dashboard", {
        user: req.session.user,
        startDate,
        endDate
    });
});
app.get("/api/revenue", requireLogin, async (req, res) => {
    try {

        /*
        |--------------------------------------------------------------------------
        | CURRENT MONTH DEFAULT
        |--------------------------------------------------------------------------
        |
        | If user does not send dates:
        |
        | startDate = 1st day of current month
        | endDate   = last day of current month
        |
        | User can override both dates using query parameters.
        |
        |--------------------------------------------------------------------------
        */

        const now = new Date();

        const currentYear = now.getFullYear();
        const currentMonth = now.getMonth();

        // First day of current month
        const defaultStartDate =
            `${currentYear}-${String(currentMonth + 1).padStart(2, "0")}-01`;

        // Last day of current month
        const lastDay =
            new Date(
                currentYear,
                currentMonth + 1,
                0
            ).getDate();

        const defaultEndDate =
            `${currentYear}-${String(currentMonth + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;


        /*
        |--------------------------------------------------------------------------
        | USER FILTER
        |--------------------------------------------------------------------------
        */

        let startDate =
            req.query.startDate ||
            defaultStartDate;

        let endDate =
            req.query.endDate ||
            defaultEndDate;


        /*
        |--------------------------------------------------------------------------
        | PAGINATION
        |--------------------------------------------------------------------------
        */

        let page =
            parseInt(req.query.page) || 1;

        let limit =
            parseInt(req.query.limit) || 10;


        if (page < 1) {
            page = 1;
        }

        if (limit < 1) {
            limit = 10;
        }

        if (limit > 100) {
            limit = 100;
        }


        /*
        |--------------------------------------------------------------------------
        | DATE VALIDATION
        |--------------------------------------------------------------------------
        */

        const dateRegex =
            /^\d{4}-\d{2}-\d{2}$/;


        if (
            !dateRegex.test(startDate) ||
            !dateRegex.test(endDate)
        ) {

            return res.status(400).json({

                success: false,

                message:
                    "Invalid date format. Use YYYY-MM-DD."

            });

        }


        /*
        |--------------------------------------------------------------------------
        | CHECK START <= END
        |--------------------------------------------------------------------------
        */

        if (startDate > endDate) {

            return res.status(400).json({

                success: false,

                message:
                    "Start date cannot be greater than end date."

            });

        }


        /*
        |--------------------------------------------------------------------------
        | MYSQL DATE RANGE
        |--------------------------------------------------------------------------
        |
        | Example:
        |
        | startDate = 2026-09-01
        | endDate   = 2026-09-30
        |
        | Query:
        |
        | >= 2026-09-01 00:00:00
        | <  2026-10-01 00:00:00
        |
        | This includes the complete end date.
        |
        |--------------------------------------------------------------------------
        */

        const startDateTime =
            `${startDate} 00:00:00`;


        const endDateObject =
            new Date(
                Number(endDate.substring(0, 4)),
                Number(endDate.substring(5, 7)) - 1,
                Number(endDate.substring(8, 10))
            );


        endDateObject.setDate(
            endDateObject.getDate() + 1
        );


        const endDateFormatted =
            `${endDateObject.getFullYear()}-${String(
                endDateObject.getMonth() + 1
            ).padStart(2, "0")}-${String(
                endDateObject.getDate()
            ).padStart(2, "0")}`;


        const endDateTime =
            `${endDateFormatted} 00:00:00`;


        /*
        |--------------------------------------------------------------------------
        | MAIN REVENUE QUERY
        |--------------------------------------------------------------------------
        */

        const query = `

            SELECT

                DATE(createdAt) AS report_date,

                CASE

                    WHEN bundle_id = 1235
                        THEN 'Yumzzy'

                    WHEN bundle_id = 1237
                        THEN 'Eduwav'

                    ELSE
                        CONCAT(
                            'Bundle ',
                            bundle_id
                        )

                END AS service,

                bundle_id,

                SUM(
                    CASE
                        WHEN event_id = 1
                        THEN 1
                        ELSE 0
                    END
                ) AS activations,

                SUM(
                    CASE
                        WHEN event_id = 3
                        THEN 1
                        ELSE 0
                    END
                ) AS renewals,

                SUM(
                    CASE
                        WHEN event_id IN (1, 3)
                        THEN amount
                        ELSE 0
                    END
                ) AS total_amount,

                COUNT(*) AS total_transactions

            FROM
                hutch_new_portals.hutch_callback_logs

            WHERE

                createdAt >= ?

                AND createdAt < ?

                AND bundle_id IN (
                    1235,
                    1237
                )

                AND event_id IN (
                    1,
                    3
                )

            GROUP BY

                DATE(createdAt),

                bundle_id

            ORDER BY

                report_date DESC,

                bundle_id ASC

        `;


        const [rows] =
            await pool.execute(
                query,
                [
                    startDateTime,
                    endDateTime
                ]
            );


        /*
        |--------------------------------------------------------------------------
        | TOTAL SUMMARY
        |--------------------------------------------------------------------------
        */

        let totalRevenue = 0;

        let totalActivations = 0;

        let totalRenewals = 0;

        let totalTransactions = 0;

        let yumzzyRevenue = 0;

        let eduwavRevenue = 0;


        rows.forEach(row => {

            const revenue =
                Number(row.total_amount) || 0;

            const activations =
                Number(row.activations) || 0;

            const renewals =
                Number(row.renewals) || 0;

            const transactions =
                Number(row.total_transactions) || 0;


            totalRevenue += revenue;

            totalActivations += activations;

            totalRenewals += renewals;

            totalTransactions += transactions;


            if (
                row.service === "Yumzzy"
            ) {

                yumzzyRevenue +=
                    revenue;

            }


            if (
                row.service === "Eduwav"
            ) {

                eduwavRevenue +=
                    revenue;

            }

        });


        /*
        |--------------------------------------------------------------------------
        | DAY-WISE DATA
        |--------------------------------------------------------------------------
        */

        const dayMap = {};


        rows.forEach(row => {

            const date =
                row.report_date;


            if (!dayMap[date]) {

                dayMap[date] = {

                    report_date: date,

                    revenue: 0,

                    activations: 0,

                    renewals: 0,

                    transactions: 0

                };

            }


            dayMap[date].revenue +=
                Number(row.total_amount) || 0;


            dayMap[date].activations +=
                Number(row.activations) || 0;


            dayMap[date].renewals +=
                Number(row.renewals) || 0;


            dayMap[date].transactions +=
                Number(row.total_transactions) || 0;

        });


        const dailyData =
            Object.values(dayMap);


        /*
        |--------------------------------------------------------------------------
        | PAGINATION
        |--------------------------------------------------------------------------
        */

        const totalDays =
            dailyData.length;


        const totalPages =
            Math.ceil(
                totalDays / limit
            );


        const offset =
            (page - 1) * limit;


        const paginatedDaily =
            dailyData.slice(
                offset,
                offset + limit
            );


        /*
        |--------------------------------------------------------------------------
        | SERVICE-WISE DATA
        |--------------------------------------------------------------------------
        */

        const serviceMap = {};


        rows.forEach(row => {

            const service =
                row.service;


            if (!serviceMap[service]) {

                serviceMap[service] = {

                    service,

                    revenue: 0,

                    activations: 0,

                    renewals: 0,

                    transactions: 0

                };

            }


            serviceMap[service].revenue +=
                Number(row.total_amount) || 0;


            serviceMap[service].activations +=
                Number(row.activations) || 0;


            serviceMap[service].renewals +=
                Number(row.renewals) || 0;


            serviceMap[service].transactions +=
                Number(row.total_transactions) || 0;

        });


        /*
        |--------------------------------------------------------------------------
        | SERVICE PERCENTAGE
        |--------------------------------------------------------------------------
        */

        const services =
            Object.values(
                serviceMap
            ).map(service => ({

                ...service,

                percentage:
                    totalRevenue > 0

                        ? (
                            service.revenue /
                            totalRevenue
                        ) * 100

                        : 0

            }));


        /*
        |--------------------------------------------------------------------------
        | RESPONSE
        |--------------------------------------------------------------------------
        */

        return res.json({

            success: true,

            filters: {

                startDate,

                endDate,

                isDefaultCurrentMonth:
                    !req.query.startDate &&
                    !req.query.endDate

            },

            summary: {

                totalRevenue:
                    Number(
                        totalRevenue.toFixed(2)
                    ),

                totalActivations,

                totalRenewals,

                totalTransactions,

                yumzzyRevenue:
                    Number(
                        yumzzyRevenue.toFixed(2)
                    ),

                eduwavRevenue:
                    Number(
                        eduwavRevenue.toFixed(2)
                    )

            },

            services,

            dailyData:
                paginatedDaily,

            details:
                rows,

            pagination: {

                currentPage:
                    page,

                perPage:
                    limit,

                totalDays,

                totalPages

            }

        });


    } catch (error) {

        console.error(
            "REVENUE API ERROR:",
            error
        );

        return res.status(
            500
        ).json({

            success: false,

            message:
                "Unable to fetch revenue data.",

            error:
                error.message

        });

    }
});

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

        const [users] = await pool.execute(`
            SELECT id FROM dashboard_users
            WHERE username = ?
            LIMIT 1
        `, ["admin"]);

        if (!users.length) {
            const hashedPassword = await bcrypt.hash("Admin@123", 12);

            await pool.execute(`
                INSERT INTO dashboard_users
                (username, password, role, status)
                VALUES (?, ?, 'admin', 1)
            `, ["admin", hashedPassword]);

            console.log("Default admin created.");
            console.log("Username: admin");
            console.log("Password: Admin@123");
        }
    } catch (error) {
        console.error("DATABASE INITIALIZATION ERROR:", error);
        process.exit(1);
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
        });
    } catch (error) {
        console.error("SERVER START ERROR:", error.message);
        process.exit(1);
    }
}

startServer();
