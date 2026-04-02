# Business Setup Checklist

> Phase 0 deliverable for PR-001 (Platform Strategy).
> Work through these steps sequentially — dependencies are noted on each step.
> Last updated: 2026-04-01.

---

## Overview of Dependencies

```
1. Domain registration  (independent — do first to lock the name)
        │
        ▼
2. LLC filing  (independent — do in parallel with domain)
        │
        ▼
3. EIN application  (requires LLC to be filed)
        │
        ▼
4. Business bank account  (requires EIN)
        │
        ▼
5. GitHub organization  (independent — can do any time, but use business email)
        │
        ▼
6. AWS account  (independent — but fund it from business bank account)
        │
        ▼
7. Service accounts  (can begin in parallel once bank account exists)
```

---

## Step 1 — Domain Name Check and Registration

**Depends on**: nothing

**Background**: Lock the domain before filing the LLC so you know the name is available end-to-end. Domain availability does not reserve a business name, but losing a domain after the LLC is filed is painful.

### Domain candidates to check

| Domain | Notes |
|--------|-------|
| `ideate.ai` | Premium TLD, strong AI association. Check Namecheap/GoDaddy for current pricing — `.ai` domains are typically $60–$100/yr. |
| `ideate.dev` | Google-operated TLD, developer audience. ~$12–$15/yr. |
| `useideate.com` | Fallback if `ideate.*` is taken. `.com` is ~$12–$15/yr. |
| `getideate.com` | Common startup pattern. ~$12–$15/yr. |
| `ideate.io` | Developer/startup TLD. ~$30–$50/yr. |
| `ideate.app` | Google-operated, HTTPS-required TLD. ~$15–$20/yr. |

### Where to check and register

- **Namecheap** — https://www.namecheap.com (competitive pricing, free WHOIS privacy)
- **Google Domains / Squarespace Domains** — https://domains.squarespace.com (clean UI, good Google Workspace integration)
- **Cloudflare Registrar** — https://www.cloudflare.com/registrar/ (at-cost pricing, no markup, best choice if using Cloudflare for DNS anyway)

**Recommendation**: Register with Cloudflare Registrar. At-cost pricing and you will likely use Cloudflare for DNS management anyway. Free WHOIS privacy included.

### Actions

- [ ] Check availability of all candidates above
- [ ] Register preferred domain
- [ ] Enable WHOIS privacy (free on most registrars)
- [ ] Note expiry date and enable auto-renew

**Estimated cost**: $12–$100/yr depending on TLD selected  
**Estimated time**: 15–30 minutes

---

## Step 2 — LLC Filing

**Depends on**: nothing (can run in parallel with Step 1)

### State selection

**Delaware** vs **home state** — the two most common choices:

| Factor | Delaware | Home State |
|--------|----------|------------|
| Startup reputation | Preferred by VCs and investors | Neutral |
| Filing fee | $90 (Certificate of Formation) | Varies ($50–$500) |
| Annual franchise tax | $300/yr minimum (Flat rate for small LLCs is $300) | Varies by state |
| Registered agent required | Yes ($0–$300/yr) | Yes if you use one (optional in some states) |
| Best if... | Seeking funding, have investors | Staying bootstrapped, operating in one state |

**Recommendation for bootstrapped pre-revenue stage**: File in your home state. Delaware's advantages (investor preference, flexible corporate law) matter more when raising money. Home state filing avoids paying two annual fees (Delaware + home state) and simplifies taxes while you are pre-revenue.

If you are in California: note CA has an $800/yr minimum franchise tax on all LLCs, which applies regardless of Delaware vs CA filing once you operate in CA. Factor this into the cost comparison.

### Filing options

**DIY** (cheapest):
- Find your state's Secretary of State website (search "[your state] LLC filing")
- File Articles of Organization online
- Most states: $50–$200 one-time filing fee

**Formation services** (saves time, handles registered agent):
- **Northwest Registered Agent** — https://www.northwestregisteredagent.com — $39 formation + $125/yr registered agent. Recommended for privacy (keeps your home address off public filings).
- **Stripe Atlas** — https://stripe.com/atlas — $500 flat, Delaware C-Corp or LLC, includes registered agent for 1 year, EIN, and bank account referrals. Higher cost but streamlined for startups.
- **LegalZoom** — https://www.legalzoom.com — $0 + state fee for basic, but upsells aggressively.

**Registered agent**: Required if you file in Delaware or want your personal address kept off public record. Northwest Registered Agent at $125/yr is the practical choice.

### Actions

- [ ] Decide: Delaware vs home state
- [ ] Choose formation method (DIY or service)
- [ ] File Articles of Organization
- [ ] Designate a registered agent
- [ ] Receive confirmation / Certificate of Formation (keep this document)
- [ ] Draft an Operating Agreement (required in some states; good practice everywhere — templates available from Northwest or LegalZoom)

**Estimated cost**: $50–$500 one-time + $125–$300/yr (registered agent + annual report fees)  
**Estimated time**: 1–3 business days (online filing); some states same-day

---

## Step 3 — EIN Application (Employer Identification Number)

**Depends on**: Step 2 (LLC must be filed and confirmed)

The EIN is the tax ID for the business. Required for a business bank account, hiring, and most financial accounts. Free from the IRS.

### How to apply

**Online (fastest)**:
- IRS EIN Assistant: https://www.irs.gov/businesses/small-businesses-self-employed/apply-for-an-employer-identification-number-ein-online
- Available Monday–Friday 7am–10pm ET
- EIN issued immediately upon completion
- You must be the LLC's responsible party (member or manager)

**By fax or mail**: Also available but takes days to weeks. Use online.

### Actions

- [ ] Gather LLC formation documents (you will need the exact legal name and state/date of formation)
- [ ] Apply online at the IRS EIN Assistant link above
- [ ] Download and save the EIN confirmation letter (CP 575) — banks will ask for this

**Estimated cost**: Free  
**Estimated time**: 15 minutes online (immediate issuance)

---

## Step 4 — Business Bank Account

**Depends on**: Step 3 (EIN required by all business banks)

Keep business finances completely separate from personal from day one. This protects the LLC's liability shield and simplifies taxes.

### Options

| Bank | Monthly Fee | Notes |
|------|-------------|-------|
| **Mercury** (https://mercury.com) | $0 | Best for startups. FDIC-insured via partner banks. Free wires, no minimums, excellent API. Highly recommended. |
| **Relay** (https://relayfi.com) | $0 basic / $30 pro | Good alternative. 20 checking accounts, physical card, no minimums. |
| **Brex** (https://brex.com) | $0 for cash account | Startup-focused, good card rewards. |
| **Chase Business Complete** | $15/mo (waivable) | Traditional bank, useful if you need in-person banking. Waived with $2k balance. |

**Recommendation**: Mercury. Zero fees, built for startups, Stripe integration is seamless, and it will handle AWS/service charges cleanly.

### What you will need to open

- LLC Certificate of Formation
- EIN confirmation letter (CP 575)
- Government-issued ID
- Personal SSN (for identity verification of beneficial owner)
- Business address (can be registered agent address)

### Actions

- [ ] Open account at Mercury (or chosen bank)
- [ ] Fund the account with initial capital (even $500–$1000 to cover formation and service costs)
- [ ] Order a business debit card
- [ ] Set up bill pay or auto-pay for recurring LLC costs (registered agent, domain renewal)

**Estimated cost**: $0 (Mercury) to $15/mo  
**Estimated time**: 1–3 business days for account approval

---

## Step 5 — GitHub Organization

**Depends on**: nothing technically, but use your business email address when creating it

The four private repos needed for the platform all live under this organization:
- `ideate-server` — GraphQL API + Neo4j + server-side PPR
- `ideate-portal` — Web dashboard, Auth0, Shopify billing
- `ideate-corporate` — Marketing site, docs
- `ideate-infra` — Shared infrastructure (VPC, DNS, Neo4j, secrets)

The existing `ideate` repo (public, Claude Code plugin) stays under the personal account or can be transferred to the org.

### Creating the organization

- Go to: https://github.com/organizations/plan
- Choose **Free** tier initially (unlimited public repos, unlimited private repos with 3 free collaborators)
- Upgrade to **Team** ($4/user/month) when you add contributors beyond yourself

### Organization name suggestions

| Name | Notes |
|------|-------|
| `ideate-platform` | Clear, available likely |
| `ideateai` | Short, mirrors domain if ideate.ai is registered |
| `useideate` | Mirrors domain if useideate.com is registered |

**Recommendation**: Match the org name to the primary domain you registered in Step 1.

### Actions

- [ ] Create GitHub organization at https://github.com/organizations/plan
- [ ] Set organization name (match domain)
- [ ] Create the four private repos: `ideate-server`, `ideate-portal`, `ideate-corporate`, `ideate-infra`
- [ ] Set up branch protection rules on `main` for each repo (require PR reviews)
- [ ] Consider transferring the public `ideate` repo to the org (optional — can keep personal)

**Estimated cost**: $0 (Free tier) or $4/user/month (Team tier)  
**Estimated time**: 30 minutes

---

## Step 6 — AWS Account Under Business Entity

**Depends on**: Step 4 (fund with business bank account/card)

Create a net-new AWS account registered to the LLC, not your personal account. This is critical for liability separation and clean billing.

Do not use an existing personal AWS account — create a new one.

### Account creation

- AWS sign-up: https://aws.amazon.com/free/
- Use your **business email address** (e.g., aws@yourdomain.com — create this mailbox first)
- Enter the LLC's name as the account name
- Use the business bank card for billing

### Free tier highlights (12 months from account creation)

| Service | Free Tier |
|---------|-----------|
| EC2 | 750 hrs/mo t2.micro or t3.micro |
| RDS | 750 hrs/mo db.t2.micro, 20 GB storage |
| S3 | 5 GB storage, 20k GET, 2k PUT/mo |
| Lambda | 1M requests/mo, 400k GB-seconds compute |
| CloudFront | 1 TB data transfer/mo |
| ECR | 500 MB/mo private registry storage |

Note: Neo4j on AWS is not free tier — use Neo4j Aura Free (Step 7) during development and only provision an EC2/RDS-based Neo4j instance when moving toward production.

### AWS account structure recommendation

For a bootstrapped startup, a simple multi-account setup is sufficient:

| Account | Purpose |
|---------|---------|
| `ideate-root` | Billing consolidation only, no workloads |
| `ideate-dev` | Development and staging workloads |
| `ideate-prod` | Production workloads (create later) |

Use AWS Organizations (free) to consolidate billing across accounts. This is a best practice and costs nothing.

### Actions

- [ ] Create a business email address (e.g., aws@yourdomain.com) — use Gmail/Workspace or Cloudflare Email Routing to a personal address
- [ ] Create AWS account at https://aws.amazon.com/free/ using business email and LLC name
- [ ] Add business bank card as payment method
- [ ] Enable MFA on the root account immediately
- [ ] Create an IAM admin user (do not use root for daily work)
- [ ] Set up a billing alert at $10/mo to catch unexpected charges
- [ ] Optionally: enable AWS Organizations and create dev/prod sub-accounts

**Estimated cost**: $0 free tier (first 12 months), then pay-as-you-go  
**Estimated time**: 30–60 minutes

---

## Step 7 — Service Account Setup

**Depends on**: Step 4 (business bank account for paid tiers when needed)

These services are needed for the platform stack. All have free tiers sufficient for development and early production.

---

### 7a. Auth0

**Purpose**: Authentication for ideate-portal (login, user management, multi-tenant isolation)

**Sign-up**: https://auth0.com/signup

| Tier | Price | Limits |
|------|-------|--------|
| Free | $0 | 7,500 monthly active users, unlimited logins, 3 social connections, no custom domains |
| Essentials | $35/mo | 500 MAU included, custom domains, additional connections |
| Professional | $240/mo | 1,000 MAU, organizations (multi-tenancy), SSO |

**Free tier is sufficient for development and early launch** (up to 7,500 MAU is generous for a new product).

**Note from steering doc**: Auth0 is the current preference; evaluate free tier limits before committing. Alternatives to evaluate: Clerk (https://clerk.com — $25/mo, simpler DX), Cognito (AWS-native, complex, cheap at scale).

**Actions**:
- [ ] Create Auth0 account with business email
- [ ] Create a tenant named for your org (e.g., `ideate-dev`)
- [ ] Note the domain (e.g., `ideate-dev.us.auth0.com`) — needed in portal config

**Estimated cost**: $0 (Free tier)  
**Estimated time**: 15 minutes

---

### 7b. Neo4j Aura

**Purpose**: Graph database for ideate-server (knowledge graph, PPR traversal)

**Sign-up**: https://console.neo4j.io/

| Tier | Price | Limits |
|------|-------|--------|
| AuraDB Free | $0 | 1 free instance, 200K nodes, 400K relationships, pauses after 3 days of inactivity |
| AuraDB Professional | ~$65/mo | 1 instance, 10M nodes, no pause, production SLA |
| AuraDB Enterprise | Custom | Multi-region, dedicated, SSO |

**Free tier is sufficient for development** and likely for early production depending on graph size. The pause-after-inactivity behavior on Free means you need to upgrade to Professional before launch.

**Alternative**: Self-host Neo4j Community Edition on an EC2 instance. Community Edition is free but self-managed. Reasonable for a bootstrapped startup willing to handle ops.

**Actions**:
- [ ] Create Neo4j Aura account at https://console.neo4j.io/ with business email
- [ ] Create a free AuraDB instance (name it `ideate-dev`)
- [ ] Save the connection URI, username, and password in a secrets manager (AWS Secrets Manager or 1Password)

**Estimated cost**: $0 (AuraDB Free) → $65/mo (AuraDB Professional when ready for production)  
**Estimated time**: 15 minutes

---

### 7c. GitHub (organization already created in Step 5)

**Purpose**: Private repos for the four platform services

Covered in Step 5. No additional action needed here unless upgrading to Team tier.

| Tier | Price | Limits |
|------|-------|--------|
| Free | $0 | Unlimited public and private repos, 3 collaborators on private repos, 2,000 Actions minutes/mo |
| Team | $4/user/mo | Unlimited collaborators, 3,000 Actions minutes/mo, code owners, required reviewers |

**Upgrade to Team when**: You add a second contributor or need required reviewer enforcement.

**Estimated cost**: $0 (Free) or $4/user/mo (Team)

---

### 7d. Shopify (for billing)

**Purpose**: Per-seat subscription billing for ideate-portal

**Sign-up**: https://www.shopify.com/plus/solutions/saas

Shopify billing for SaaS (recurring subscriptions) requires a Shopify Partner account, not a standard storefront account.

**Sign-up as a partner**: https://partners.shopify.com/signup

| Mode | Price | Notes |
|------|-------|-------|
| Development store | $0 | Free development and testing, cannot charge real customers |
| Basic | $29/mo (store) | Can use Shopify for subscription billing via apps |

**Note from steering doc**: Shopify billing is confirmed for per-seat subscriptions; exact tiers and pricing TBD. This service account is set up now so the integration can be designed; real billing is not needed until Phase 4 (portal MVP).

**Alternative to evaluate**: Stripe Billing (https://stripe.com/billing) — simpler API, no storefront overhead, 0.5–0.8% fee on managed subscriptions. More appropriate for a pure API/SaaS product without a need for a physical product catalog. Strongly consider Stripe Billing as the default and only use Shopify if the storefront/marketplace angle is valuable.

**Actions**:
- [ ] Create Shopify Partner account at https://partners.shopify.com/signup (free)
- [ ] OR create Stripe account at https://dashboard.stripe.com/register (free, recommended if no physical products)
- [ ] Defer actual subscription setup until Phase 4

**Estimated cost**: $0 (Shopify Partner dev mode or Stripe test mode)  
**Estimated time**: 15 minutes

---

## Cost Summary

### Upfront costs

| Item | Estimated Cost |
|------|---------------|
| Domain registration | $12–$100 (varies by TLD) |
| LLC filing fee | $50–$200 (varies by state) |
| Registered agent (first year) | $0–$125 |
| EIN | $0 |
| **Total upfront** | **$62–$425** |

### Recurring costs (annual)

| Item | Estimated Annual Cost |
|------|-----------------------|
| Domain renewal | $12–$100/yr |
| Registered agent | $0–$125/yr |
| State annual report / franchise tax | $50–$300/yr (varies by state; Delaware LLC flat rate is $300/yr) |
| **Total recurring (low estimate)** | **~$162/yr** |
| **Total recurring (Delaware + .ai domain)** | **~$525/yr** |

### Service accounts (development phase)

All service accounts listed in Step 7 operate on free tiers during development.

| Service | Free Tier | First paid tier |
|---------|-----------|-----------------|
| Auth0 | 7,500 MAU | $35/mo (Essentials) |
| Neo4j Aura | 200K nodes, pauses | $65/mo (Professional) |
| GitHub | 3 collaborators | $4/user/mo (Team) |
| AWS | 12-month free tier | Pay-as-you-go |
| Shopify Partner | Dev store free | $29/mo (if storefront needed) |

**Total monthly cost during development**: ~$0 (assuming AWS stays within free tier)

---

## Execution Order Summary

| # | Step | Est. Cost | Est. Time | Blocker For |
|---|------|-----------|-----------|-------------|
| 1 | Domain registration | $12–$100/yr | 30 min | Nothing (do first) |
| 2 | LLC filing | $50–$325 one-time | 1–3 days | EIN (Step 3) |
| 3 | EIN application | Free | 15 min | Bank account (Step 4) |
| 4 | Business bank account | $0–$15/mo | 1–3 days | Funding services |
| 5 | GitHub organization | $0 | 30 min | Repo creation |
| 6 | AWS account | $0 (free tier) | 60 min | Cloud infra |
| 7a | Auth0 | $0 (free tier) | 15 min | Portal auth |
| 7b | Neo4j Aura | $0 (free tier) | 15 min | Server graph DB |
| 7c | GitHub repos | $0 | 30 min | All dev work |
| 7d | Shopify/Stripe | $0 (dev mode) | 15 min | Billing (Phase 4) |
