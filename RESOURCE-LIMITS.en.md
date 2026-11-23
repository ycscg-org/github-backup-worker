# Resource Usage Estimates & Security Hardening

This document explains the actual resource consumption of this project under the **Cloudflare free tier**, along with WAF rate-limiting advice to prevent quota abuse. All figures are counted operation by operation from the real calls made in `src/index.js`.

**Bottom line first**: Normal personal use incurs no charges. Of the four quotas, the first to be maxed out is **KV writes (1,000/day)**; the only thing that can produce a bill is **R2 storage exceeding 10 GB**. Only three extreme scenarios trigger overage — high-frequency manual operations in the panel, setting the R2 space limit above 10 GB, and the `/webhook` or `/admin` endpoints being hammered.

---

## 1. Resource Consumption per Operation

| Operation | Worker Requests | KV Writes | KV Deletes | D1 Row Reads | D1 Row Writes | R2 Writes |
|---|---|---|---|---|---|---|
| Open / refresh admin panel | 4 | 0 | 0 | ~60 | 0 | 0 |
| Manual single-repo backup (once) | ~5 | 2 | 2 | ~10 | 1+ | 1 |
| Full-org backup (10 repos) | ~12–23 | 2 | 2 | ~100 | 10+ | 10 |
| Save settings and clean old backups | ~7 | 2 | 2 | ~20 | 1+ | 0 |
| **Webhook auto backup (one push)** | 1 | **0** | **0** | ~10 | 1+ | 1 |

The most important point: **the Webhook auto-backup path never touches KV** — it neither writes nor deletes. If you rely on push-triggered auto backups, the tightest KV write quota is never consumed at all.

---

## 2. Free Quotas and Exhaustion Thresholds

| Resource | Free Quota | Exhaustion Condition | Likelihood |
|---|---|---|---|
| KV writes | 1,000/day | ~500 panel backups/day | Low |
| KV deletes | 1,000/day | ~500 panel backups/day | Low |
| KV reads | 100,000/day | ~30,000 panel operations/day | Very low |
| Worker requests | 100,000/day | ~20,000 manual backups, or 100,000 Webhooks/day | Very low |
| D1 row reads | 5,000,000 rows/day | ~500,000 backups/day | Nearly impossible |
| D1 row writes | 100,000 rows/day | ~50,000 backups/day | Nearly impossible |
| R2 storage | 10 GB/month | See section 3 | **At risk** |
| R2 Class A operations | 1,000,000/month | ~1,000,000 successful backups/month | Nearly impossible |
| R2 Class B operations | 10,000,000/month | ~10,000,000 downloads/month | Nearly impossible |

KV **writes** and **deletes** are two separate 1,000/day quotas, and each panel backup consumes 2 of each, so both are maxed out at roughly the same point — around 500 operations. This is the first line to be crossed among the four quotas.

---

## 3. R2 Storage Capacity Estimates

R2 free storage is 10 GB/month, and usage is driven by **data volume** rather than operation count. The formula:

```text
Storage used ≈ number of repos × number of branches × copies kept per repo × average bundle size
```

| Average bundle size | To fill 8 GB keeping 5 copies (repos × branches) | To fill 8 GB keeping 1 copy |
|---|---|---|
| 20 MB | ~80 | ~400 |
| 50 MB | ~32 | ~160 |
| 100 MB | ~16 | ~80 |

A few notes:

- The project ships with protection: the default is `r2_max_gb = 8`. On reaching 8 GB it first auto-cleans redundancy (keeping only the latest 1 copy per repo), and if that is still not enough it pauses all backups. **As long as this limit stays at or below 10, R2 never exceeds the free tier.**
- The only operation that actually costs money: setting the R2 limit above 10 in the system settings (for example, 50).
- R2 **object deletion is not a billable operation**, so the tool's cleanup actions incur no Class A operation charges.
- The R2 free tier is measured as "the average of daily storage peaks within the billing cycle", not the month-end balance; a daily peak below 8 GB is safe.

---

## 4. WAF Rate-Limiting Advice

### 4.1 Spec Constraints of Free-Plan Rate Limiting

| Item | Free plan |
|---|---|
| Number of rules | Usually only **1** (multiple only on Pro) |
| Counting dimension | **Per client IP** |
| Request period | Minimum **10 seconds** |
| Action | Mainly Block |

Counting per IP on the free plan is a hard limit: each IP is counted separately, so **switching IP bypasses it**, and distributed flooding is outside the protection of this rule.

### 4.2 What Threshold to Set

When a single IP floods continuously and sits right at the threshold edge, the allowed volume = threshold ÷ period seconds × 86400:

| Threshold (per 10 s) | Worst-case single-IP daily allowance | vs 100,000/day |
|---|---|---|
| 20 | 172,800 | Over by 73% |
| 15 | 129,600 | Over by 30% |
| **10 (recommended)** | 86,400 | 14% spare |
| 5 | 43,200 | 57% spare |

- Only a threshold **≤ 10** guarantees that even a single IP in the worst case cannot push the 100,000/day quota to exhaustion.
- Normal backup operations (opening the panel is about 4 requests, one backup about 5) are far below this line and will not be wrongly blocked.
- Requests stopped by rate limiting are returned at the edge and **never forwarded to the Worker, consuming no request quota** — this is exactly the value of this rule.

### 4.3 Mitigation Duration Matters More Than the Threshold

- Once triggered, the IP is blocked for a period (Mitigation timeout / Action Duration). **Set this as long as possible** (the longest available option, for example 1 hour); while blocked, none of that IP's requests are counted.
- If the mitigation duration is only 10 seconds, you effectively let a batch through every 20 seconds, and the actual allowance approaches the worst-case values in the table above; set it to 1 hour and, after a single trigger, that IP's flooding over the next hour is all discarded, making real consumption far lower than the theoretical value.
- If no long duration is available, prioritize lowering the threshold to 5–10.

### 4.4 Rule Syntax and Recommended Values

Matching the backup domains, a 10-second window, a threshold of 10, and the maximum mitigation duration:

```text
(lower(http.host) eq "iptv.ai99cn.com") or (lower(http.host) eq "fkgit.ai99cn.com")
```

If you prefer to protect only the admin panel and Webhook without affecting other paths, change the condition to match by path:

```text
(http.request.uri.path eq "/admin") or (http.request.uri.path eq "/webhook")
```

Each approach has trade-offs: matching by host covers the whole site, matching by path protects only the key endpoints — on the free plan you can pick only one.

---

## 5. Three Practices to Ensure Zero Cost

- **Keep the R2 limit at 8 GB**: the default is 8; do not raise it, and the storage line will never be crossed.
- **Prefer Webhook-triggered auto backups**: this path consumes zero KV, fully saving the tightest write quota.
- **Add access control to `/webhook` and `/admin`**: use Cloudflare's rate-limiting rule to stop abnormal high-frequency requests and prevent the Worker request count from being maliciously consumed.

> Note: if the rate-limiting rule also covers domains with other normal traffic, the 10-requests/10-seconds threshold may wrongly block legitimate users; restricting it to the backup-only domains, or switching to path matching, is safer. In addition, per-IP counting on the free plan cannot stop distributed flooding, but the chance of a personal project being targeted is very low, and combined with the 8 GB R2 limit it is safe enough.
