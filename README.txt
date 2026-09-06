HUTCH REVENUE DASHBOARD

1. Copy .env.example to .env and set your MySQL credentials.
2. Your existing table is NOT modified:
   hutch_new_portals.hutch_callback_logs
3. Run:
   npm install
   node server.js
4. Open:
   http://localhost:3000
5. Default login:
   Username: admin
   Password: Admin@123

The application automatically creates only the dashboard_users authentication
table and the default admin account if it does not already exist.

Revenue:
bundle_id 1235 = Yumzzy
bundle_id 1237 = Eduwav
event_id 1 = Activations
event_id 3 = Renewals
