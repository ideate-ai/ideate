# Bootstrap Guide: ideate-infra

> Shared infrastructure foundations for the ideate platform. This repo owns anything that crosses service boundaries: VPC, DNS zones, container registry, Neo4j cluster, and secrets management.
>
> **Boundary rule**: If it has an AWS account number, VPC ID, or DNS zone in it, it belongs here. If it's "how to build and run this service," it stays co-located in the service repo.

---

## 1. Create the GitHub Repo

1. Go to github.com → New repository
2. Name: `ideate-infra`
3. Visibility: **Private**
4. Initialize with a README
5. Clone locally:

```bash
git clone git@github.com:<your-org>/ideate-infra.git
cd ideate-infra
```

---

## 2. IaC Tool: Terraform

**Recommendation: Terraform.**

Terraform has the broadest adoption, extensive community modules, multi-cloud support if needed later, and a large pool of existing examples and documentation. HCL is declarative and purpose-built for infrastructure. State management uses S3 + DynamoDB for remote locking.

| Tool | Rationale |
|---|---|
| **Terraform (chosen)** | Broadest adoption, multi-cloud ready, extensive AWS provider coverage. HCL is purpose-built for infra. Huge community module ecosystem. State management well-understood (S3 + DynamoDB). |
| CDK | TypeScript-native, matches app stack. But adds a compile step and CloudFormation abstraction layer. Less portable if multi-cloud becomes relevant. |
| Pulumi | TypeScript support, but thinner community. No clear advantage over Terraform for infrastructure work. |

**Install Terraform:**

```bash
brew install terraform
terraform --version
```

---

## 3. Scaffold the Repo Structure

```
ideate-infra/
├── modules/
│   ├── networking/              # VPC, subnets, security groups
│   │   ├── main.tf
│   │   ├── variables.tf
│   │   └── outputs.tf
│   ├── dns/                     # Route 53 hosted zone
│   │   ├── main.tf
│   │   ├── variables.tf
│   │   └── outputs.tf
│   ├── registry/                # ECR container registry
│   │   ├── main.tf
│   │   ├── variables.tf
│   │   └── outputs.tf
│   ├── neo4j/                   # Neo4j cluster (staging/prod)
│   │   ├── main.tf
│   │   ├── variables.tf
│   │   └── outputs.tf
│   └── secrets/                 # Secrets Manager baseline
│       ├── main.tf
│       ├── variables.tf
│       └── outputs.tf
├── environments/
│   ├── staging/
│   │   ├── main.tf              # Staging root module
│   │   ├── terraform.tfvars     # Staging-specific values
│   │   └── backend.tf           # S3 state backend config
│   └── prod/
│       ├── main.tf
│       ├── terraform.tfvars
│       └── backend.tf
├── docker/
│   └── docker-compose.yml       # Local dev stack (see Section 6)
├── state/
│   └── bootstrap.tf             # One-time: creates S3 bucket + DynamoDB for state
├── .terraform-version           # tfenv version pinning
└── README.md
```

Initialize:

```bash
# Pin Terraform version
echo "1.14.8" > .terraform-version

# Bootstrap remote state (one-time)
cd state && terraform init && terraform apply
cd ..

# Initialize staging environment
cd environments/staging && terraform init
```

---

## 4. Environment Tiers

### dev (local Docker Compose)

No AWS resources. Everything runs on the developer's machine via Docker Compose. Zero cloud spend.

- Neo4j Community Edition container
- ideate-server (GraphQL API) container
- No DNS, no VPC, no secrets manager — environment variables in `.env` files

See Section 6 for the Docker Compose setup.

### staging (minimal cloud)

Minimal AWS footprint. Used to validate deployment and integration before promoting to prod.

| Resource | Spec | Approx. Monthly Cost |
|---|---|---|
| VPC | Single region, 2 AZs, public + private subnets | Free |
| ECS Fargate | 1 task, 0.25 vCPU / 512 MB (ideate-server) | ~$9 |
| Neo4j (self-hosted EC2) | t3.small, gp3 20 GB | ~$15 |
| ECR | Container registry (shared with prod) | ~$1 |
| Route 53 | Hosted zone + staging subdomain | ~$1 |
| Secrets Manager | 5 secrets | ~$2 |
| **Total** | | **~$28/month** |

> Neo4j Aura Free tier is an alternative for staging: 1 free instance, 200K nodes, 400K relationships, pauses after 3 days of inactivity. **Warning**: free-tier instances are permanently deleted after 90 days of inactivity — unsuitable for long-lived staging data. Eliminates EC2 cost but imposes size constraints and deletion risk. Good for early validation, but self-hosted gives more headroom and matches prod topology.

### prod (scaled cloud)

| Resource | Spec | Approx. Monthly Cost |
|---|---|---|
| VPC | Multi-AZ, NAT gateway, private subnets | ~$35 |
| ECS Fargate | 2 tasks (auto-scaling), 0.5 vCPU / 1 GB each | ~$30 |
| Neo4j | r6i.large EC2 + gp3 100 GB, or Neo4j Aura Professional | ~$120–$200 |
| ECR | Container registry | ~$2 |
| Route 53 | Hosted zone + records | ~$2 |
| ALB | Application load balancer | ~$18 |
| Secrets Manager | 10–20 secrets | ~$5 |
| CloudWatch | Logs + basic alarms | ~$10 |
| **Total** | | **~$220–$300/month** |

> Scale down by starting with a single ECS task and no NAT gateway (use VPC endpoints instead). Prod can start closer to $80–$100/month if traffic is low.

---

## 5. Shared Infrastructure Baseline

These are the foundations ideate-infra owns and provisions. Each service consumes outputs (VPC ID, cluster ARN, ECR repo URLs, secret ARNs) via Terraform outputs or SSM Parameter Store.

### VPC

- One VPC per environment (staging, prod)
- 2+ Availability Zones
- Public subnets: load balancers, NAT gateways
- Private subnets: application tier, database tier
- VPC endpoints for ECR and Secrets Manager (avoids NAT gateway costs for AWS service calls)

### DNS Zone

- Route 53 hosted zone for the apex domain (e.g., `ideate.app`)
- Subdomains delegated per environment: `api.staging.ideate.app`, `api.ideate.app`
- Each service creates its own DNS records pointing to its load balancer, but the hosted zone lives here

### Container Registry (ECR)

- One ECR repository per service: `ideate-server`, `ideate-portal`, `ideate-corporate`
- Lifecycle policy: keep last 10 untagged images, never expire tagged releases
- Cross-account access not needed initially; all services deploy from the same AWS account

### Neo4j Cluster

- **Dev**: Docker container (Community Edition), no persistence concern
- **Staging**: Single EC2 instance (t3.small), EBS volume, Neo4j Community Edition
- **Prod**: EC2 (r6i.large or similar memory-optimized), EBS gp3, automated snapshots, or Neo4j Aura Professional for managed option
- Neo4j Enterprise is not needed unless multi-clustering or causal clustering is required (post-launch concern)

### Secrets Management

- AWS Secrets Manager for all credentials: Neo4j auth, Auth0 client secrets, Shopify API keys, internal service tokens
- Naming convention: `/<env>/<service>/<secret-name>` (e.g., `/staging/ideate-server/neo4j-password`)
- Services reference secrets by ARN in task definitions — never in environment variables checked into source control
- Rotation: manual initially, automated where AWS supports it natively

---

## 6. Local Development Setup (Docker Compose)

This is the priority. It unblocks ideate-server development immediately with zero cloud spend.

Create `docker/docker-compose.yml`:

```yaml
services:

  neo4j:
    image: neo4j:2026-community
    container_name: ideate-neo4j
    ports:
      - "7474:7474"   # Neo4j Browser
      - "7687:7687"   # Bolt protocol
    environment:
      NEO4J_AUTH: neo4j/${NEO4J_PASSWORD:-localpassword}
      NEO4J_PLUGINS: '["apoc"]'
      NEO4J_server_memory_pagecache_size: 512M
      NEO4J_server_memory_heap_initial__size: 512M
      NEO4J_server_memory_heap_max__size: 1G
    volumes:
      - neo4j_data:/data
      - neo4j_logs:/logs
    healthcheck:
      test: ["CMD", "cypher-shell", "-u", "neo4j", "-p", "${NEO4J_PASSWORD:-localpassword}", "RETURN 1"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s

  ideate-server:
    image: ideate-server:local
    build:
      context: ../../ideate-server    # path to ideate-server repo (adjust as needed)
      dockerfile: Dockerfile
    container_name: ideate-server
    ports:
      - "4000:4000"   # GraphQL endpoint
    environment:
      NEO4J_URI: bolt://neo4j:7687
      NEO4J_USER: neo4j
      NEO4J_PASSWORD: ${NEO4J_PASSWORD:-localpassword}
      NODE_ENV: development
      PORT: 4000
    depends_on:
      neo4j:
        condition: service_healthy
    volumes:
      - ../../ideate-server:/app     # live-reload for development
      - /app/node_modules            # prevent host node_modules from overwriting container
    command: npm run dev

volumes:
  neo4j_data:
  neo4j_logs:
```

Create a companion `docker/.env.example`:

```bash
# Copy to docker/.env and fill in values
NEO4J_PASSWORD=localpassword
```

### Usage

```bash
cd docker/

# Copy env template
cp .env.example .env

# Start Neo4j only (no ideate-server image required yet)
docker compose up neo4j

# Start full stack once ideate-server has a Dockerfile
docker compose up

# Open Neo4j Browser
open http://localhost:7474
# Connect with: bolt://localhost:7687, user: neo4j, password: localpassword

# Stop and remove volumes (full reset)
docker compose down -v
```

### Notes

- Neo4j Browser is available at `http://localhost:7474` — useful for inspecting the graph during development
- The `ideate-server` service uses a bind mount for live reload. Adjust the `context` path to match where you've cloned `ideate-server` relative to `ideate-infra`
- APOC plugin is included — required for several graph operations ideate-server will use (e.g., `apoc.periodic.iterate` for bulk imports)
- The `NEO4J_PASSWORD` default (`localpassword`) is intentionally weak and only used locally. Never commit a real password to `.env`

---

## 7. Bootstrap ideate in the New Repo

Once the repo is scaffolded, initialize ideate tracking:

```bash
cd ideate-infra
/ideate:init
```

This bootstraps `.ideate/` for the infra repo, allowing infrastructure work to be planned and tracked the same way as application code.

---

## 8. Next Steps

| Step | Owner | Unblocks |
|---|---|---|
| Create GitHub repo (private) | Human | Everything |
| Run `docker compose up neo4j` | Human | ideate-server local dev |
| Bootstrap Terraform state (S3 + DynamoDB) | Human/Terraform | Cloud provisioning |
| Provision staging VPC + ECR | Human/Terraform | Service deployments |
| Provision staging Neo4j EC2 | Human/Terraform | Remote backend validation |
| Configure Secrets Manager baseline | Human/Terraform | Auth0, Shopify integration |

The Docker Compose setup (step 2) is the immediate priority — it enables ideate-server development to start without any AWS account or cloud spend.
