/**
 * HVAC Dispatch Voice Agent — Generic Multi-Tenant VAPI Backend Worker
 *
 * Repurposed from the Jamie (412Singles) + Bella (RxPilot) Cloudflare Worker
 * pattern. Generic because:
 *
 *   1. MULTI-TENANT ROUTING: VAPI sends the inbound "to" phone number on every
 *      webhook/tool-call. This worker looks up TENANTS[toNumber] to decide
 *      which business/knowledge-base/CRM adapter to use — so the SAME worker
 *      (and even the same VAPI assistant, if you use dynamic variables) can
 *      serve multiple HVAC companies, each with their own phone number,
 *      service area, pricing, and dispatch/CRM backend.
 *
 *   2. CRM/DISPATCH ADAPTER PATTERN: `getCrmAdapter(tenant)` returns a thin
 *      interface (createWorkOrder, getWorkOrderStatus, findAvailableSlots,
 *      escalate) backed by whichever system the tenant actually uses.
 *      Ships with:
 *        - "internal"      — KV-only, zero external dependencies (default,
 *                             works out of the box for a demo)
 *        - "servicetitan"  — stub calling ServiceTitan's Jobs/Booking API
 *        - "housecallpro"  — stub calling Housecall Pro's Jobs API
 *        - "jobber"        — stub calling Jobber's GraphQL API
 *      Each stub is ~20 lines — fill in the tenant's real API key/base URL
 *      in TENANTS and the adapter "just works" without touching the rest of
 *      the worker.
 *
 * Routes:
 *   POST /vapi/webhook           - VAPI end-of-call-report + transcript events
 *   POST /vapi/tools/:toolName   - VAPI function/tool calls during the call
 *                                  (create_work_order, check_status,
 *                                   find_next_slot, escalate_emergency)
 *   GET  /pending                - Unnotified calls (for heartbeat/dashboard polling)
 *   POST /ack/:id                - Mark call as notified
 *   GET  /work-orders            - List work orders (dashboard)
 *   GET  /health                 - Health check
 *   GET  /debug                  - Debug last webhook received
 */

// ---------------------------------------------------------------------------
// TENANT CONFIG — one entry per inbound phone number. This is what makes the
// SAME worker + SAME VAPI number pool serve multiple HVAC companies with
// different knowledge/dispatch backends, as requested.
// ---------------------------------------------------------------------------
const TENANTS = {
  // Demo tenant — Dallas, TX placeholder number. Swap for the real
  // VAPI-provisioned number once purchased (keep the key in sync with
  // whatever VAPI sends as the "to" number on webhooks/tool calls).
  '+19726667107': {
    id: 'demo-hvac-co',
    name: 'Demo HVAC Co.',
    crm: 'internal',                 // 'internal' | 'servicetitan' | 'housecallpro' | 'jobber'
    crmConfig: {},                   // api keys/base urls go here per-tenant
    serviceArea: ['Dallas, TX', 'Fort Worth, TX'],
    emergencyKeywords: ['no heat', 'no ac', 'gas smell', 'gas leak', 'carbon monoxide', 'flooding', 'sparking'],
    escalationPhone: '+12145550911',
    businessHours: '7am-7pm Mon-Sat',
  },
  // Fallback alias so the demo still works if the real number isn't wired up yet
  'DEMO_PHONE_NUMBER': {
    id: 'demo-hvac-co',
    name: 'Demo HVAC Co.',
    crm: 'internal',
    crmConfig: {},
    serviceArea: ['Dallas, TX', 'Fort Worth, TX'],
    emergencyKeywords: ['no heat', 'no ac', 'gas smell', 'gas leak', 'carbon monoxide', 'flooding', 'sparking'],
    escalationPhone: '+12145550911',
    businessHours: '7am-7pm Mon-Sat',
  },
  // Example of a second tenant on the same worker, different number + CRM:
  // '+18135551212': {
  //   id: 'acme-hvac',
  //   name: 'Acme Heating & Air',
  //   crm: 'servicetitan',
  //   crmConfig: { tenantId: 'XXXX', apiKey: 'env:ACME_SERVICETITAN_KEY' },
  //   serviceArea: ['Tampa Bay, FL'],
  //   emergencyKeywords: ['no heat', 'no ac', 'gas smell'],
  //   escalationPhone: '+18135559999',
  //   businessHours: '24/7 emergency, 8am-6pm routine',
  // },
};

function resolveTenant(toNumber) {
  return TENANTS[toNumber] || TENANTS['DEMO_PHONE_NUMBER'];
}

// ---------------------------------------------------------------------------
// CRM / DISPATCH ADAPTERS
// ---------------------------------------------------------------------------
function getCrmAdapter(tenant, env) {
  switch (tenant.crm) {
    case 'servicetitan': return serviceTitanAdapter(tenant, env);
    case 'housecallpro': return housecallProAdapter(tenant, env);
    case 'jobber': return jobberAdapter(tenant, env);
    case 'internal':
    default: return internalAdapter(tenant, env);
  }
}

// --- Internal (KV-backed) adapter — zero external dependencies, demo-ready ---
function internalAdapter(tenant, env) {
  return {
    async createWorkOrder({ customerName, customerPhone, address, issue, urgency, preferredWindow }) {
      const id = `WO-${tenant.id.toUpperCase().slice(0, 4)}-${Date.now().toString(36).toUpperCase()}`;
      const workOrder = {
        id, tenantId: tenant.id, customerName, customerPhone, address, issue, urgency,
        preferredWindow: preferredWindow || null,
        status: 'scheduled',
        createdAt: new Date().toISOString(),
      };
      await env.CALLS.put(`workorder:${id}`, JSON.stringify(workOrder), { expirationTtl: 90 * 24 * 60 * 60 });
      await env.CALLS.put(`workorder-index:${id}`, tenant.id, { expirationTtl: 90 * 24 * 60 * 60 });
      return { id, status: 'scheduled', message: `Work order ${id} created for ${customerName}.` };
    },
    async getWorkOrderStatus({ workOrderId, customerPhone }) {
      const raw = await env.CALLS.get(`workorder:${workOrderId}`);
      if (!raw) return { found: false, message: 'No work order found with that ID.' };
      const wo = JSON.parse(raw);
      if (customerPhone && wo.customerPhone && wo.customerPhone !== customerPhone) {
        return { found: false, message: 'That work order does not match the phone number on file.' };
      }
      return { found: true, status: wo.status, issue: wo.issue, preferredWindow: wo.preferredWindow };
    },
    async findAvailableSlots({ date }) {
      // Demo stub — real tenants replace this with a call to their scheduling API
      const slots = ['8:00am-10:00am', '10:00am-12:00pm', '1:00pm-3:00pm', '3:00pm-5:00pm'];
      return { date: date || 'tomorrow', slots };
    },
    async escalate({ reason, customerPhone }) {
      return { escalated: true, escalationPhone: tenant.escalationPhone, reason };
    },
  };
}

// --- ServiceTitan adapter stub (fill in real endpoints + OAuth when ready) ---
function serviceTitanAdapter(tenant, env) {
  const base = tenant.crmConfig.baseUrl || 'https://api.servicetitan.io';
  async function call(path, opts = {}) {
    const res = await fetch(`${base}${path}`, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenant.crmConfig.accessToken || ''}`,
        'ST-App-Key': tenant.crmConfig.appKey || '',
        ...(opts.headers || {}),
      },
    });
    return res.json();
  }
  return {
    async createWorkOrder(p) {
      // POST /jpm/v2/tenant/{tenantId}/jobs  (shape simplified — adjust to real schema)
      return call(`/jpm/v2/tenant/${tenant.crmConfig.tenantId}/jobs`, {
        method: 'POST',
        body: JSON.stringify({ summary: p.issue, customer: { name: p.customerName, phone: p.customerPhone }, location: { address: p.address } }),
      });
    },
    async getWorkOrderStatus(p) {
      return call(`/jpm/v2/tenant/${tenant.crmConfig.tenantId}/jobs/${p.workOrderId}`);
    },
    async findAvailableSlots(p) {
      return call(`/dispatch/v2/tenant/${tenant.crmConfig.tenantId}/capacity?date=${p.date || ''}`);
    },
    async escalate(p) { return { escalated: true, escalationPhone: tenant.escalationPhone, reason: p.reason }; },
  };
}

// --- Housecall Pro adapter stub ---
function housecallProAdapter(tenant, env) {
  const base = 'https://api.housecallpro.com';
  async function call(path, opts = {}) {
    const res = await fetch(`${base}${path}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tenant.crmConfig.apiKey || ''}`, ...(opts.headers || {}) },
    });
    return res.json();
  }
  return {
    async createWorkOrder(p) {
      return call('/jobs', {
        method: 'POST',
        body: JSON.stringify({ description: p.issue, customer: { name: p.customerName, mobile_number: p.customerPhone }, address: p.address }),
      });
    },
    async getWorkOrderStatus(p) { return call(`/jobs/${p.workOrderId}`); },
    async findAvailableSlots(p) { return call(`/availability?date=${p.date || ''}`); },
    async escalate(p) { return { escalated: true, escalationPhone: tenant.escalationPhone, reason: p.reason }; },
  };
}

// --- Jobber adapter stub (GraphQL API) ---
function jobberAdapter(tenant, env) {
  const endpoint = 'https://api.getjobber.com/api/graphql';
  async function gql(query, variables) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenant.crmConfig.accessToken || ''}`,
        'X-JOBBER-GRAPHQL-VERSION': '2025-01-20',
      },
      body: JSON.stringify({ query, variables }),
    });
    return res.json();
  }
  return {
    async createWorkOrder(p) {
      return gql(
        `mutation CreateJob($input: JobCreateInput!) { jobCreate(input: $input) { job { id } } }`,
        { input: { title: p.issue, client: { name: p.customerName, phone: p.customerPhone }, propertyAddress: p.address } }
      );
    },
    async getWorkOrderStatus(p) {
      return gql(`query GetJob($id: ID!) { job(id: $id) { id jobStatus } }`, { id: p.workOrderId });
    },
    async findAvailableSlots(p) { return { date: p.date, slots: [] }; }, // Jobber scheduling API integration TBD
    async escalate(p) { return { escalated: true, escalationPhone: tenant.escalationPhone, reason: p.reason }; },
  };
}

// ---------------------------------------------------------------------------
// WORKER ENTRYPOINT
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    try {
      if (path === '/health') {
        return json({ status: 'ok', service: 'hvac-dispatch-voice-agent', tenants: Object.keys(TENANTS).length }, corsHeaders);
      }

      if (path === '/debug') {
        const lastWebhook = await env.CALLS.get('debug:last-webhook');
        return json({ lastWebhook: lastWebhook ? JSON.parse(lastWebhook) : null }, corsHeaders);
      }

      // --- VAPI in-call tool calls ---------------------------------------
      if (path.startsWith('/vapi/tools/') && request.method === 'POST') {
        const toolName = path.replace('/vapi/tools/', '');
        const body = await request.json();
        // VAPI tool-call payload shape: { message: { toolCalls: [{ id, function: { name, arguments } }] , call: { ... } } }
        const toolCall = body.message?.toolCalls?.[0];
        const args = toolCall?.function?.arguments ? JSON.parse(toolCall.function.arguments) : body.arguments || {};
        const toNumber = body.message?.call?.phoneNumber?.number || body.message?.call?.to || args.toNumber || 'DEMO_PHONE_NUMBER';
        const tenant = resolveTenant(toNumber);
        const crm = getCrmAdapter(tenant, env);

        let result;
        switch (toolName) {
          case 'create_work_order':
            result = await crm.createWorkOrder(args);
            break;
          case 'check_status':
            result = await crm.getWorkOrderStatus(args);
            break;
          case 'find_next_slot':
            result = await crm.findAvailableSlots(args);
            break;
          case 'escalate_emergency':
            result = await crm.escalate(args);
            break;
          default:
            result = { error: `Unknown tool: ${toolName}` };
        }

        // VAPI expects tool-call results in this shape
        return json({
          results: [{ toolCallId: toolCall?.id || 'unknown', result: JSON.stringify(result) }],
        }, corsHeaders);
      }

      // --- VAPI end-of-call-report + events ------------------------------
      if (path === '/vapi/webhook' && request.method === 'POST') {
        const body = await request.json();
        await env.CALLS.put('debug:last-webhook', JSON.stringify({ receivedAt: new Date().toISOString(), body }), { expirationTtl: 24 * 60 * 60 });

        const messageType = body.message?.type || body.type;
        if (messageType !== 'end-of-call-report') {
          return json({ status: 'ignored', type: messageType }, corsHeaders);
        }

        const call = body.message?.call || body.call || body.message || body;
        const callId = call?.id || `call-${Date.now()}`;
        const toNumber = call?.phoneNumber?.number || call?.to || 'DEMO_PHONE_NUMBER';
        const tenant = resolveTenant(toNumber);
        const structuredData = call?.analysis?.structuredData || call?.structuredData || {};

        const callData = {
          id: callId,
          tenantId: tenant.id,
          tenantName: tenant.name,
          timestamp: new Date().toISOString(),
          customerNumber: call?.customer?.number || call?.customerNumber || 'Unknown',
          duration: call?.endedAt && call?.startedAt
            ? Math.round((new Date(call.endedAt) - new Date(call.startedAt)) / 1000) : null,
          summary: call?.analysis?.summary || call?.summary || 'No summary available',
          callerName: structuredData.callerName || null,
          callerPhone: structuredData.callerPhone || null,
          issue: structuredData.issue || null,
          urgency: structuredData.urgency || null,
          requestType: structuredData.requestType || null,
          workOrderId: structuredData.workOrderId || null,
          wantsCallback: structuredData.wantsCallback || false,
          transcript: call?.transcript || null,
          recordingUrl: call?.recordingUrl || null,
          cost: call?.cost || null,
          status: call?.status || 'ended',
          endedReason: call?.endedReason || null,
          notified: false,
        };

        await env.CALLS.put(`call:${callId}`, JSON.stringify(callData), { expirationTtl: 30 * 24 * 60 * 60 });
        await env.CALLS.put(`pending:${callId}`, callId, { expirationTtl: 24 * 60 * 60 });

        return json({ status: 'stored', callId, tenant: tenant.id }, corsHeaders);
      }

      // --- Dashboard / heartbeat polling endpoints -----------------------
      if (path === '/pending' && request.method === 'GET') {
        const pendingList = await env.CALLS.list({ prefix: 'pending:' });
        const pendingCalls = [];
        for (const key of pendingList.keys) {
          const callId = await env.CALLS.get(key.name);
          if (callId) {
            const callData = await env.CALLS.get(`call:${callId}`);
            if (callData) pendingCalls.push(JSON.parse(callData));
          }
        }
        return json({ calls: pendingCalls, count: pendingCalls.length }, corsHeaders);
      }

      if (path.startsWith('/ack/') && request.method === 'POST') {
        const callId = path.replace('/ack/', '');
        await env.CALLS.delete(`pending:${callId}`);
        const callData = await env.CALLS.get(`call:${callId}`);
        if (callData) {
          const call = JSON.parse(callData);
          call.notified = true;
          call.notifiedAt = new Date().toISOString();
          await env.CALLS.put(`call:${callId}`, JSON.stringify(call), { expirationTtl: 30 * 24 * 60 * 60 });
        }
        return json({ status: 'acknowledged', callId }, corsHeaders);
      }

      if (path === '/work-orders' && request.method === 'GET') {
        const indexList = await env.CALLS.list({ prefix: 'workorder-index:' });
        const orders = [];
        for (const key of indexList.keys) {
          const woId = key.name.replace('workorder-index:', '');
          const raw = await env.CALLS.get(`workorder:${woId}`);
          if (raw) orders.push(JSON.parse(raw));
        }
        orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        return json({ workOrders: orders, count: orders.length }, corsHeaders);
      }

      return json({ error: 'Not found' }, corsHeaders, 404);
    } catch (error) {
      console.error('Error:', error);
      return json({ error: error.message }, corsHeaders, 500);
    }
  },
};

function json(data, corsHeaders = {}, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
}
