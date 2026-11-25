# Riley — HVAC Dispatch Voice Agent (Demo)

A generic, multi-tenant VAPI voice AI agent for HVAC dispatch/work-order intake, repurposed from the backend pattern behind **Jamie** (412Singles member services) and **Bella** (RxPilot pharmacy intake).

**Status:** Demo build — backend generic & deployable now; VAPI assistant + phone number + branding to be provisioned per-prospect.

## Why this is reusable, not a one-off

- **Multi-tenant by phone number.** The Cloudflare Worker reads the inbound VAPI `to` number on every webhook/tool call and resolves a tenant config (`TENANTS` map in `worker/src/index.js`). Each tenant gets its own name, service area, escalation number, emergency keywords, and CRM backend — all from one deployed worker.
- **CRM/dispatch adapter pattern.** `getCrmAdapter(tenant)` returns `{ createWorkOrder, getWorkOrderStatus, findAvailableSlots, escalate }`. Ships with:
  - `internal` — zero-dependency KV-backed adapter (works immediately for a demo, no CRM needed)
  - `servicetitan`, `housecallpro`, `jobber` — stub adapters hitting each platform's real API; swap in API keys and they work without touching the rest of the worker
- **Same call-logging/dashboard pattern as Jamie/Bella** — end-of-call-report webhook → KV store → dashboard reads `/calls` and `/work-orders` on demand (manual refresh).
- **Free-tier KV budget.** No request path uses KV `list()` (1,000/day on the free plan). Work orders and pending calls each keep one index document (`index:workorders`, `index:pending`) updated on write, so a dashboard refresh costs one KV read. Dashboard routes require `Authorization: Bearer <DASHBOARD_KEY>` and are rejected before touching KV; webhook debug capture is off unless `DEBUG_WEBHOOKS=1`.

## Repo Layout

```
worker/
  src/index.js      — Cloudflare Worker (multi-tenant backend + CRM adapters)
  wrangler.toml     — Worker config (needs a KV namespace created + ID filled in)
docs/
  index.html        — Public-facing demo landing page (GH Pages)
  dashboard.html     — Live dashboard (calls + work orders)
RILEY-PROMPT.md     — VAPI system prompt + function-tool spec
```

## Deploy Checklist (2-day demo turnaround)

1. **Cloudflare:**
   ```bash
   cd worker
   npx wrangler kv namespace create CALLS   # get the namespace ID
   # paste the ID into wrangler.toml
   npx wrangler deploy
   ```
2. **VAPI:**
   - Buy a phone number (or reuse a sandbox number) for the demo
   - Create an assistant named "Riley" using `RILEY-PROMPT.md`
   - Add the 4 function tools pointing at `https://<worker>.workers.dev/vapi/tools/<name>`
   - Set `serverUrl` to `https://<worker>.workers.dev/vapi/webhook`
   - Fill in `{{COMPANY_NAME}}`, `{{SERVICE_AREA}}`, `{{ESCALATION_PHONE}}`, `{{BUSINESS_HOURS}}` in the prompt for the prospect's actual company
   - Update `TENANTS['DEMO_PHONE_NUMBER']` in `worker/src/index.js` to the real VAPI number string and redeploy
3. **Dashboard:** enable GitHub Pages on `docs/`. Set the Worker secrets (never put keys in the page — it's public):
   ```bash
   cd worker
   npx wrangler secret put DASHBOARD_KEY      # any long random string; viewers type it into the dashboard once
   npx wrangler secret put VAPI_API_KEY       # VAPI private key, used server-side by GET /calls
   npx wrangler secret put VAPI_WEBHOOK_SECRET  # optional: also set as the assistant's server secret in VAPI
   ```
   Set `VAPI_ASSISTANT_ID` under `[vars]` in `wrangler.toml`.
4. **Demo script:** call the number live, walk through a routine booking + one emergency-triage call, then show the dashboard populate in real time.

## Swapping in a real CRM

Edit the tenant entry in `worker/src/index.js`:
```js
'+1XXXXXXXXXX': {
  id: 'acme-hvac',
  name: 'Acme Heating & Air',
  crm: 'servicetitan',              // or 'housecallpro' | 'jobber'
  crmConfig: { tenantId: '...', accessToken: '...', appKey: '...' },
  serviceArea: ['Tampa Bay, FL'],
  emergencyKeywords: ['no heat', 'no ac', 'gas smell', 'carbon monoxide'],
  escalationPhone: '+1XXXXXXXXXX',
  businessHours: '24/7 emergency, 8am-6pm routine',
},
```
No other code changes needed — the adapter stub handles the API shape.

## Related Projects

| Project | Pattern reused |
|---|---|
| [menonpg/412singles-voice-agent](https://github.com/menonpg/412singles-voice-agent) | Jamie — member services voice agent, call logging |
| [menonpg/bella-vapi](https://github.com/menonpg/bella-vapi) | Bella — dashboard UI, VAPI call-list integration |
| [menonpg/412singles-alerts](https://github.com/menonpg/412singles-alerts) | Original Cloudflare Worker webhook pattern this was built from |

---

*Built by ThinkCreate.AI. Not affiliated with ServiceTitan, Housecall Pro, or Jobber.*
