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
        const now = new Date();
        const currentYear = now.getFullYear();
        const currentMonth = now.getMonth();
        const defaultStartDate =`${currentYear}-${String(currentMonth + 1).padStart(2, "0")}-01`;
        const lastDay =
            new Date(
                currentYear,
                currentMonth + 1,
                0
            ).getDate();

        const defaultEndDate =
            `${currentYear}-${String(currentMonth + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;


        let startDate =
            req.query.startDate ||
            defaultStartDate;

        let endDate =
            req.query.endDate ||
            defaultEndDate;

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

        if (startDate > endDate) {
            return res.status(400).json({
                success: false,
                message:
                    "Start date cannot be greater than end date."

            });
        }

        const startDateTime = `${startDate} 00:00:00`;
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
                        WHEN event_id = 1
                        AND charge_result = 1
                        THEN 1
                        ELSE 0
                    END
                ) AS paid_activations,

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


        // =========================================================
        // EXECUTE QUERY
        // =========================================================

        const [rows] =
            await pool.execute(
                query,
                [
                    startDateTime,
                    endDateTime
                ]
            );


        // =========================================================
        // SUMMARY VARIABLES
        // =========================================================

        let totalRevenue = 0;

        let totalActivations = 0;

        let totalPaidActivations = 0;

        let totalRenewals = 0;

        let totalTransactions = 0;

        let yumzzyRevenue = 0;

        let eduwavRevenue = 0;


        rows.forEach(row => {

            const revenue =
                Number(row.total_amount) || 0;


            const activations =
                Number(row.activations) || 0;


            const paidActivations =
                Number(row.paid_activations) || 0;


            const renewals =
                Number(row.renewals) || 0;


            const transactions =
                Number(row.total_transactions) || 0;

            totalRevenue += revenue;
            totalActivations += activations;
            totalPaidActivations += paidActivations;
            totalRenewals += renewals;
            totalTransactions += transactions;

            if (row.service === "Yumzzy") {

                yumzzyRevenue += revenue;

            }


            if (row.service === "Eduwav") {

                eduwavRevenue += revenue;

            }

        });


        // =========================================================
        // DAY-WISE DATA
        // =========================================================

        const dayMap = {};


        rows.forEach(row => {

            const date =
                row.report_date;


            if (!dayMap[date]) {

                dayMap[date] = {

                    report_date: date,

                    revenue: 0,

                    activations: 0,

                    paidActivations: 0,

                    renewals: 0,

                    transactions: 0

                };

            }


            // -----------------------------------------------------
            // Revenue
            // -----------------------------------------------------

            dayMap[date].revenue +=
                Number(row.total_amount) || 0;


            // -----------------------------------------------------
            // Activations
            // -----------------------------------------------------

            dayMap[date].activations +=
                Number(row.activations) || 0;


            // -----------------------------------------------------
            // Paid Activations
            // -----------------------------------------------------

            dayMap[date].paidActivations +=
                Number(row.paid_activations) || 0;


            // -----------------------------------------------------
            // Renewals
            // -----------------------------------------------------

            dayMap[date].renewals +=
                Number(row.renewals) || 0;


            // -----------------------------------------------------
            // Transactions
            // -----------------------------------------------------

            dayMap[date].transactions +=
                Number(row.total_transactions) || 0;

        });


        const dailyData =
            Object.values(dayMap);


        // =========================================================
        // PAGINATION
        // =========================================================

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


        // =========================================================
        // SERVICE-WISE DATA
        // =========================================================

        const serviceMap = {};


        rows.forEach(row => {

            const service =
                row.service;


            if (!serviceMap[service]) {

                serviceMap[service] = {

                    service,

                    revenue: 0,

                    activations: 0,

                    paidActivations: 0,

                    renewals: 0,

                    transactions: 0

                };

            }


            // -----------------------------------------------------
            // Revenue
            // -----------------------------------------------------

            serviceMap[service].revenue +=
                Number(row.total_amount) || 0;


            // -----------------------------------------------------
            // Activations
            // -----------------------------------------------------

            serviceMap[service].activations +=
                Number(row.activations) || 0;


            // -----------------------------------------------------
            // Paid Activations
            // -----------------------------------------------------

            serviceMap[service].paidActivations +=
                Number(row.paid_activations) || 0;


            // -----------------------------------------------------
            // Renewals
            // -----------------------------------------------------

            serviceMap[service].renewals +=
                Number(row.renewals) || 0;


            // -----------------------------------------------------
            // Transactions
            // -----------------------------------------------------

            serviceMap[service].transactions +=
                Number(row.total_transactions) || 0;

        });


        // =========================================================
        // SERVICE PERCENTAGE
        // =========================================================

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


        // =========================================================
        // RESPONSE
        // =========================================================

        return res.json({

            success: true,


            // =====================================================
            // FILTERS
            // =====================================================

            filters: {

                startDate,

                endDate,

                isDefaultCurrentMonth:
                    !req.query.startDate &&
                    !req.query.endDate

            },


            // =====================================================
            // SUMMARY
            // =====================================================

            summary: {

                totalRevenue:
                    Number(
                        totalRevenue.toFixed(2)
                    ),


                // All event_id = 1
                totalActivations,


                // event_id = 1 AND chargeResult = TRUE
                totalPaidActivations,


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


            // =====================================================
            // SERVICE DATA
            // =====================================================

            services,


            // =====================================================
            // DAY-WISE DATA
            // =====================================================

            dailyData:
                paginatedDaily,


            // =====================================================
            // COMPLETE DETAILS
            // =====================================================

            details:
                rows,


            // =====================================================
            // PAGINATION
            // =====================================================

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
        return res.status(500).json({
            success: false,
            message:"Unable to fetch revenue data.",
            error: error.message
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
