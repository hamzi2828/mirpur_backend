# Branches & Permissions — guide for the frontend team and the owner

All admin routes need `Authorization: Bearer <token>`. When this guide says **(see code)**, check the
controller for the final response shape. Related guide: `BARCODES_BOXES_BATCHES.md`.

## 1. Concepts

| Word | Meaning |
|---|---|
| **Branch** | One shop (Branch 1, Branch 2...). Has `name`, `code` (e.g. `B1`), `address`, `phone`, `isActive`, `isMain`. |
| **Main branch** | Exactly one. Old stock and old sales (before branches existed) belong to it. |
| **Product catalog** | Shared products (made by the super admin) are seen by every branch. Same barcode, short code and selling price everywhere. |
| **Branch product** | A product made by branch staff has `ownerBranch` = their branch: only that branch and the super admin see it (lists, POS, scans, labels, stock report, dashboard). It can't be transferred to another branch. The super admin can change it in the product form ("Who can see this product": All branches / one branch only) — send `ownerBranch` = branch id, or empty for shared. Barcodes and short codes stay unique across ALL branches. The website only shows shared products. |
| **Branch stock** | Each branch has its OWN stock of every product / variant. |
| **Super admin** | The owner. Sees and manages everything: all branches, products, staff, roles. |
| **Branch staff** | A login that belongs to ONE branch. Only sees that branch's stock, sales, held orders, purchases, expenses, reports. |
| **Role** | A set of permissions (e.g. "Cashier"). The super admin creates roles and gives one to each staff user. |
| **Permission** | `key` + `action`. Actions: `view`, `create`, `edit`, `delete`, `export`. |

New permission keys: `branches` (see all branches), `staff` (manage staff logins), `stock_transfers`,
`stock_receive`. The full list comes from `GET /admin/roles/catalogue`.

Default roles (created by the migration, editable): **Admin** (system, everything), **Branch Manager**
(runs the whole shop of their branch: dashboard, POS, POS orders, load, all branch reports, products,
categories, attributes, stock receive/transfer, customers, banks, expenses, staff of their own branch —
everything except branches, roles, settings and activity log), **Cashier** (dashboard, POS sell,
POS orders view, customers, products view).
To give an existing Branch Manager role these defaults: `npm run sync:branch-manager` (dry run), then
`npm run sync:branch-manager -- --apply`.

## 2. Super admin vs branch staff

| | Super admin | Branch staff |
|---|---|---|
| Branch | none (all branches) | always their own branch, cannot change it |
| Permissions | everything | only what their role allows (else HTTP 403) |
| Branch switcher | yes: "All branches" or one branch | no (shows their branch name only) |
| Sales / stock writes | go to the picked branch; with "All branches" picked → main branch | their own branch |

A 403 response looks like `{ "message": "You do not have permission for this action", "required": { "keys": ["pos"], "action": "create" } }`.
Hide buttons the user cannot use (check `permissions`), but always handle 403 too.

## 3. Login and "who am I"

`POST /user/login` response now also has an `access` block:

```json
{ "message": "Login successful", "token": "...", "data": { ...user },
  "access": { "isSuperAdmin": false, "roleName": "Cashier",
              "branch": { "id": "66f...", "name": "Branch 1", "code": "B1" },
              "permissions": { "pos": ["view", "create"], "products": ["view"] } } }
```

Inactive staff (`isActive: false`) cannot log in.

`GET /me/access` (any logged-in user) — call it on app start and after switching branch:

```json
{ "data": {
  "user": { "id": "...", "firstName": "...", "lastName": "...", "email": "...", "role": "admin" },
  "isSuperAdmin": true, "roleName": "Super Admin", "branch": null,
  "permissions": { "...": ["view"] },
  "currentBranchId": null,
  "branches": [ { "id": "...", "name": "Branch 1", "code": "B1", "isMain": true } ] } }
```

`branches` = branches this user may switch to (super admin: all active ones; staff: only their own).

## 4. Branch switcher (super admin)

Send the picked branch on EVERY admin request:

- header `x-branch-id: <branchId>` (preferred), or query `?branchId=<id>`.
- No header, or `all` → "All branches" (lists and reports show everything).

Branch staff can send the header too; the server ignores it and always uses their own branch.
Remember the choice (e.g. local storage) and show it in the page header.

## 5. Endpoints

### Branches — `/admin/branches`
- `GET /admin/branches?search=&isActive=true|false` → `{ data: [ { id, name, code, address, phone, isActive, isMain } ] }`.
  Super admin: all. Staff with `branches:view` or `stock_transfers`: all active. Other staff: own only.
- `GET /admin/branches/:id`
- `POST /admin/branches` body `{ name, code, address?, phone?, isActive?, isMain? }` — super admin.
  Duplicate code → 409.
- `PUT /admin/branches/:id` same fields — super admin. The main branch cannot be deactivated.
- `DELETE /admin/branches/:id` — super admin. Refused for the main branch, or when the branch still has
  stock (transfer it first) or staff users.
- `POST /admin/branches/:id/set-main` — super admin.

### Staff logins — `/admin/staff` (super admin, or permission `staff`)
- `GET /admin/staff?search=&isActive=&staffRole=&page=&limit=&sortBy=&sortDir=` → list with
  `{ id, name, email, phone, isActive, isSuperAdmin, staffRole: { id, name }, branch: { id, name, code }, lastLogin }`.
- `GET /admin/staff/:id`
- `POST /admin/staff` body `{ firstName, lastName, email, password (min 8), phone?, staffRole, branch, isActive?, isSuperAdmin? }`.
  For a super admin user send `isSuperAdmin: true` and no branch (only a super admin may do this).
- `PUT /admin/staff/:id` — same fields, all optional.
- `POST /admin/staff/:id/reset-password` body `{ password }`.
- `DELETE /admin/staff/:id`
- Staff with the `staff` permission (not super admin) only manage staff of their own branch and can
  only give roles that do not include `staff`, `branches` or `roles`. The last super admin cannot be
  removed or demoted. **(see code)** for exact error messages.

### Roles — `/admin/roles` (unchanged)
`GET /admin/roles/catalogue`, `GET/POST /admin/roles`, `PUT /admin/roles/:id`,
`PUT /admin/roles/:id/permissions` body `{ permissions: { key: [actions] } }`, `DELETE /admin/roles/:id`.

### Stock transfers — `/admin/stock-transfers` (permission `stock_transfers`)
- `POST /admin/stock-transfers` body:
  ```json
  { "fromBranchId": "...", "toBranchId": "...", "note": "for weekend sale",
    "items": [ { "productId": "...", "variantId": "v1?", "quantity": 5, "batchNo": "10245-1?" } ] }
  ```
  The stock moves immediately (no "pending" step). Branch staff may only send FROM their own branch.
  Not enough stock → error naming the branch, e.g. "Insufficient stock for X in Branch 1. Available: 2, Requested: 5".
- `GET /admin/stock-transfers` → history list: `transferNo`, `fromBranch`, `toBranch`, `items`
  (`productName`, `variantLabel`, `quantity`, `allocations` per batch), `note`, `status`
  (`completed` / `partial` / `failed`), `createdBy`, `createdAt`. Filters **(see code)**.
- `GET /admin/stock-transfers/:id`

### Receive stock (permission `stock_receive`)
`POST /products/:id/stock/receive` (same body as before, see the barcodes guide) now adds the pieces to
the CURRENT branch: staff → their branch; super admin → the branch in `x-branch-id` (main branch if
"All branches").

## 6. How stock shows per branch

In POS and admin product lists/details:

- `stock` = pieces **in the current branch** (for variants: each `variants[i].stock` too).
  `batches` only lists batches held in that branch.
- `totalStock` = pieces in **all branches**.
- `branchStock` = `[ { branch: "<branchId>", stock: 12 }, ... ]` on each product/variant — use it for a
  "stock per branch" table (map ids to names with `GET /admin/branches`).
- With "All branches" picked, `stock` is the total.
- Status `out_of_stock` is based on the TOTAL. The POS must use `stock` (this branch) to stop selling.
- Old products (before migration) count as main branch stock.

Orders, held orders, purchases and expenses now have a `branch` field. Lists and reports are filtered
by the current branch automatically.

## 7. Screens to build

1. **Branch switcher** in the header (super admin): "All branches" + each branch. Staff: show branch name only.
2. **Branches** page (super admin): list, add/edit, activate/deactivate, "Make main", delete.
3. **Staff** page: list with role + branch columns, add/edit (role dropdown, branch dropdown,
   active switch), reset password, delete.
4. **Roles & permissions** matrix: rows = catalogue groups (by section), columns = actions,
   checkboxes only for actions the group allows.
5. **Stock transfer** page: from/to branch, product search (scan works), quantity, optional batch,
   note → submit; plus a transfer history list and detail.
6. **Receive stock**: show which branch receives (current branch).
7. **Branch column / filter** in POS orders, held orders, purchases, expenses and every report
   (super admin with "All branches"). Show `stock` + `totalStock` (and per-branch table) on product pages.
8. Hide menu items and buttons using `permissions` from `/me/access`.

## 8. Deploy order (backend team)

1. Deploy the new backend.
2. Dry run (shows what will change, writes nothing): `npm run migrate:branches`
3. Apply: `npm run migrate:branches -- --apply`
   - creates "Main Branch" (B1) if there is none; gives all old stock, orders, held orders,
     purchases and expenses to it; existing admins become super admins; creates the default roles.
   - Optional: set `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD` in `.env` before running to create
     the owner's super admin login (the password is never printed).
   - Safe to run again; it only fills in what is missing and never changes stock totals.
4. Super admin renames "Main Branch", adds more branches, creates staff logins.
5. Demo database only: `npm run seed:demo-branches` creates Branch 1/Branch 2, splits the dummy
   products' stock ~60/40 and creates demo logins (passwords printed once).
   `npm run seed:demo-branches -- --remove` undoes it.
