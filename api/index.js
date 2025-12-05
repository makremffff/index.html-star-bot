// api/index.js (Supabase REST API Mockup)

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// متطلبات الإعلانات لكل هدية (يجب أن تتطابق مع الواجهة الأمامية)
const GIFT_AD_REQUIREMENTS = {
  'bear': 200, 
  'heart': 250, 
  'box': 350, 
  'rose': 350
};

// ثابت جديد: عدد الإعلانات المطلوبة لتفعيل الإحالة (20 إعلاناً)
const REQUIRED_ADS_FOR_ACTIVE = 20;

function headers() {
  return {
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };
}

// Helpers
async function post(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

async function get(path, query = '') {
  const url = query ? `${SUPABASE_URL}/rest/v1/${path}?${query}` : `${SUPABASE_URL}/rest/v1/${path}`;
  const res = await fetch(url, {
    headers: headers()
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

async function rpc(name, params) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(params)
  });
  const data = await res.json().catch(() => null);
  if (res.status === 204) return { ok: true, status: 204, data: null };
  return { ok: res.ok, status: res.status, data };
}

// دالة مساعدة جديدة: تجلب إجمالي مشاهدات الإعلانات لجميع الهدايا لمستخدم معين
async function getAdViewsForUser(userId) {
  // يفترض أن ad_views جدول يجمع الإعلانات (gift_id, user_id, views)
  const adRes = await get('ad_views', `user_id=eq.${userId}&select=views`);
  let totalViews = 0;
  if (adRes.ok && Array.isArray(adRes.data)) {
    adRes.data.forEach(r => { 
        totalViews += Number(r.views || 0); 
    });
  }
  return totalViews;
}


// ----------------- API Handler -----------------
export default async function handler(req, res) {
  try {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return res.status(500).json({ message: 'Server misconfigured: missing Supabase env vars' });
    }

    if (req.method !== 'POST') return res.status(405).json({ message: 'Method Not Allowed' });

    const { type, ...body } = req.body || {};

    switch (type) {

      // ----------------- Register User -----------------
      case 'register': {
        const { userId, username, firstName, lastName, refal_by, initData } = body;
        if (!userId) return res.status(400).json({ message: 'userId required' });

        await upsert('users', {
          id: userId,
          username,
          first_name: firstName,
          last_name: lastName,
          ref_by: refal_by || null,
          last_activity: new Date().toISOString(),
          init_data: initData ? JSON.stringify(initData) : null
        });

        return res.status(200).json({ message: 'User registered' });
      }

      // ----------------- Watch Ad -----------------
      case 'watch-ad': {
        const { giftId, userId } = body;
        if (!giftId || !userId) return res.status(400).json({ message: 'giftId and userId required' });

        const up = await rpc('upsert_gift_action', {
          p_user_id: userId,
          p_gift_id: giftId,
          p_inc: 1,
          p_action: 'ad_view'
        });

        if (!up.ok) {
          console.error('upsert_gift_action failed', up);
          return res.status(500).json({ message: 'Failed to record ad view', rpc_response: up.data });
        }

        const adRes = await get('ad_views', `user_id=eq.${userId}&select=gift_id,views`);
        const ad_views = {};
        if (adRes.ok && Array.isArray(adRes.data)) {
          adRes.data.forEach(r => { 
            ad_views[String(r.gift_id)] = (ad_views[String(r.gift_id)] || 0) + Number(r.views || 0); 
          });
        }
        
        return res.status(200).json({ message: 'Ad view recorded', ad_views });
      }

      // ----------------- Claim Gift -----------------
      case 'claim': {
        const { giftId, userId } = body;
        if (!giftId || !userId) return res.status(400).json({ message: 'giftId and userId required' });

        const giftReqViews = GIFT_AD_REQUIREMENTS[giftId];
        if (!giftReqViews) return res.status(400).json({ message: 'Invalid gift ID or requirements missing' });

        const adRes = await get('ad_views', `user_id=eq.${userId}&gift_id=eq.${giftId}&select=views`);
        let views = 0;
        if (adRes.ok && Array.isArray(adRes.data)) {
          adRes.data.forEach(r => { views += Number(r.views || 0); });
        }

        if (views < giftReqViews) return res.status(400).json({ message: `Need ${giftReqViews} ad views to claim this gift`, current: views });

        const up = await rpc('upsert_gift_action', {
          p_user_id: userId,
          p_gift_id: giftId,
          p_inc: 1,
          p_action: 'claim'
        });

        if (!up.ok) {
          console.error('upsert_gift_action (claim) failed', up);
          return res.status(500).json({ message: 'Failed to record claim', rpc_response: up.data });
        }

        await upsert('users', { id: userId, last_claim_date: new Date().toISOString() });

        return res.status(200).json({ message: 'Gift claimed' });
      }

      // ----------------- Claim Task (Bear reward) -----------------
      case 'claim-task': {
        const { taskId, userId } = body;
        if (!taskId || !userId) return res.status(400).json({ message: 'taskId and userId required' });
        
        const up = await rpc('upsert_gift_action', {
          p_user_id: userId,
          p_gift_id: taskId,
          p_inc: 1,
          p_action: 'task_claim'
        });
        
        if (!up.ok) {
            console.error('upsert_gift_action (task) failed', up);
            return res.status(500).json({ message: 'Failed to record task claim', rpc_response: up.data });
        }

        if (taskId === 'bear') {
          await rpc('increment_user_field', { p_user_id: userId, p_field: 'bear_task_level' });
        }

        await upsert('users', { id: userId, last_claim_date: new Date().toISOString() });

        return res.status(200).json({ message: 'Task claimed' });
      }

      // ----------------- Invite Stats (تم تعديل المنطق هنا) -----------------
      case 'invite-stats': {
        const { userId } = body;
        if (!userId) return res.status(400).json({ message: 'userId required' });

        // جلب جميع المستخدمين الذين تمت إحالتهم بواسطة هذا المستخدم (ID)
        const totalRes = await get('users', `ref_by=eq.${userId}&select=id`);
        let total = 0, active = 0, pending = 0;

        if (totalRes.ok && Array.isArray(totalRes.data)) {
          total = totalRes.data.length;
          
          // حلقة للتحقق من حالة كل مستخدم تمت إحالته
          for (const u of totalRes.data) {
            // نحسب إجمالي مشاهدات الإعلانات للمستخدم المُحال
            const views = await getAdViewsForUser(u.id); 
            
            if (views >= REQUIRED_ADS_FOR_ACTIVE) {
              active++;
            } else {
              pending++;
            }
          }
        }

        return res.status(200).json({ total, active, pending });
      }

      // ----------------- Get User State -----------------
      case 'get-user-state': {
        const { userId } = body;
        if (!userId) return res.status(400).json({ message: 'userId required' });

        // ad_views
        const adRes = await get('ad_views', `user_id=eq.${userId}&select=gift_id,views`);
        const ad_views = {};
        if (adRes.ok && Array.isArray(adRes.data)) {
          adRes.data.forEach(r => {
            const k = String(r.gift_id);
            ad_views[k] = (ad_views[k] || 0) + Number(r.views || 0);
          });
        }

        // claims
        const claimRes = await get('gifts', `user_id=eq.${userId}&select=gift_id,quantity,last_claim_date`);
        const claims = {};
        if (claimRes.ok && Array.isArray(claimRes.data)) {
          claimRes.data.forEach(r => {
            const k = String(r.gift_id);
            claims[k] = {
              quantity: Number(r.quantity || 0),
              last_claim_date: r.last_claim_date || null
            };
          });
        }

        // user-level fields
        const userRes = await get('users', `id=eq.${userId}&select=last_claim_date,bear_task_level`);
        let last_claim_date = null, bear_task_level = 0;
        if (userRes.ok && Array.isArray(userRes.data) && userRes.data.length) {
          last_claim_date = userRes.data[0].last_claim_date || null;
          bear_task_level = Number(userRes.data[0].bear_task_level || 0);
        }

        return res.status(200).json({
          ad_views,
          claims,
          last_claim_date,
          bear_task_level
        });
      }

      default:
        return res.status(400).json({ message: 'Unknown type' });
    }

  } catch (err) {
    console.error('Unhandled error', err);
    return res.status(500).json({ message: 'Server error', error: String(err) });
  }
}

// ----------------- Upsert Helper -----------------
async function upsert(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: { ...headers(), 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}