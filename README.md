# Sparta App Kubernetes Migration

## 1. Project Objective

Migrate the Sparta Node.js application from a standalone Docker container on EC2 to a Kubernetes-based deployment using:

- K3s
- Kubernetes
- Amazon EC2
- Docker Hub
- Jenkins
- MongoDB

MongoDB is deployed inside the cluster using:

- StatefulSet
- PersistentVolumeClaim
- Secret for credentials
- ClusterIP Service for internal networking

## Index

- [1. Project Objective](#1-project-objective)
- [2. Final Architecture](#2-final-architecture)
- [3. Prerequisites](#3-prerequisites)
- [4. Install k3s on EC2](#4-install-k3s-on-ec2)
- [5. Create Kubernetes Namespace](#5-create-kubernetes-namespace)
- [6. Create Project Directory](#6-create-project-directory)
- [7. Deploy MongoDB (Stateful + Persistent)](#7-deploy-mongodb-stateful--persistent)
- [8. Deploy Sparta Application](#8-deploy-sparta-application)
- [9. Expose Application](#9-expose-application)
- [10. Access Application](#10-access-application)
- [11. CI/CD Integration with Jenkins](#11-cicd-integration-with-jenkins)
- [12. User Guide](#12-user-guide)
- [13. CI/CD Pipeline Flow Summary](#13-cicd-pipeline-flow-summary)
- [14. Contribution Guidelines](#14-contribution-guidelines)
- [15. Blockers and Resolutions](#15-blockers-and-resolutions)
- [16. What I Learned](#16-what-i-learned)
- [17. Benefits I Saw Personally](#17-benefits-i-saw-personally)
- [18. Next Steps (Amazon DocumentDB)](#18-next-steps-amazon-documentdb)

## 2. Final Architecture

```text
Developer -> GitHub -> Jenkins -> Docker Hub -> EC2 (k3s)
                                              |
                                +-------------+-------------+
                                |                           |
                         Sparta Deployment (2 Pods)     Mongo StatefulSet (1 Pod)
                                |                           |
                         NodePort Service (30007)      ClusterIP Service
                                                            |
                                                   PersistentVolumeClaim
```

## 3. Prerequisites

- Ubuntu 22.04 EC2 instance
  - Recommended: `t2.small` (minimum 2 GB RAM)

Security group inbound rules:

- `22` (SSH)
- `30007` (NodePort access from browser/test machine)

![alt text](screenshoot/ec2-sg.png)

## 4. Install k3s on EC2

SSH into EC2:

```bash
ssh -i your-key.pem ubuntu@EC2_PUBLIC_IP
```

Install k3s:

```bash
curl -sfL https://get.k3s.io | sh -
```

Verify:

```bash
sudo kubectl get nodes
```

Expected:

- `STATUS: Ready`

![alt text](screenshoot/k3s-installation.png)

## 5. Create Kubernetes Namespace

Using a namespace keeps resources organized.

```bash
sudo kubectl create namespace sparta
```

![alt text](screenshoot/namespace.png)

Double-check that it was created:

```bash
sudo kubectl get ns
```

![alt text](screenshoot/get-namespace.png)

## 6. Create Project Directory

All Kubernetes YAML files will be created on the EC2 instance.

Create the folder:

```bash
mkdir sparta-k8s
cd sparta-k8s
```

This keeps the configuration organized.

## 7. Deploy MongoDB (Stateful + Persistent)

### 7.1 Create MongoDB Secret (Credentials)

This file is created on the EC2 instance inside `sparta-k8s`.

Create file:

```bash
nano mongo-secret.yaml
```

Use:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: mongo-secret
  namespace: sparta
type: Opaque
stringData:
  MONGO_INITDB_ROOT_USERNAME: admin
  MONGO_INITDB_ROOT_PASSWORD: password123
```

![img](screenshoot/nano-secret.png)

Save:

- `CTRL+X`
- `Y`
- `Enter`

Apply:

```bash
sudo kubectl apply -f mongo-secret.yaml
```

Verify:

```bash
sudo kubectl -n sparta get secrets
```

![img](screenshoot/apply-secret.png)

### 7.2 Create Persistent Volume Claim

Create:

```bash
nano mongo-pvc.yaml
```

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: mongo-pvc
  namespace: sparta
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 2Gi
```

![img](screenshoot/nano-pvc.png)

Apply:

```bash
sudo kubectl apply -f mongo-pvc.yaml
```

Verify:

```bash
sudo kubectl -n sparta get pvc
```

Status should be `Bound` (this may happen after the StatefulSet is applied).

![alt text](screenshoot/persisten-volume-claim.png)

### 7.3 Create MongoDB Service (Internal)

Create:

```bash
nano mongo-service.yaml
```

```yaml
apiVersion: v1
kind: Service
metadata:
  name: mongo
  namespace: sparta
spec:
  type: ClusterIP
  selector:
    app: mongo
  ports:
    - port: 27017
      targetPort: 27017
```

![img](screenshoot/nano-service.png)

Apply:

```bash
sudo kubectl apply -f mongo-service.yaml
```

### 7.4 Create MongoDB StatefulSet

Create:

```bash
nano mongo-statefulset.yaml
```

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: mongo
  namespace: sparta
spec:
  serviceName: "mongo"
  replicas: 1
  selector:
    matchLabels:
      app: mongo
  template:
    metadata:
      labels:
        app: mongo
    spec:
      containers:
        - name: mongo
          image: mongo:6
          ports:
            - containerPort: 27017
          envFrom:
            - secretRef:
                name: mongo-secret
          volumeMounts:
            - name: mongo-storage
              mountPath: /data/db
      volumes:
        - name: mongo-storage
          persistentVolumeClaim:
            claimName: mongo-pvc
```

![img](screenshoot/nano-mongo-statfull.png)

Apply:

```bash
sudo kubectl apply -f mongo-statefulset.yaml
```

Verify:

```bash
sudo kubectl -n sparta get pods
```

![img](screenshoot/mongo-pod-running.png)

### 7.5 Database Initialization (Seeding Strategy)

### Problem

During Docker-based deployment, database seeding was executed during `npm install` using:

```bash
node seeds/seed.js
```

However, in Kubernetes:

- The Docker image is built before MongoDB exists
- The runtime MongoDB inside the cluster starts later
- Therefore, initial seed data is not inserted automatically

### Solution

A Kubernetes Job was created to:

- Run the seed script once
- Wait until MongoDB is available
- Avoid re-seeding on every deployment

This ensures:

- The database is populated automatically on first deployment
- Data remains persistent across redeployments
- Existing data is not overwritten

### Idempotent Seed Script

The seed script was modified to:

- Check if posts already exist
- Insert data only if the collection is empty

This prevents overwriting data on future executions.

### Kubernetes Seed Job

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: mongo-seed
  namespace: sparta
spec:
  backoffLimit: 2
  template:
    spec:
      restartPolicy: Never
      initContainers:
        - name: wait-for-mongo
          image: busybox:1.36
          command: ["sh", "-c", "until nc -z mongo 27017; do sleep 2; done"]
      containers:
        - name: seed
          image: jrodga1604/sparta-app:latest
          command: ["node", "seeds/seed.js"]
          env:
            - name: DB_HOST
              valueFrom:
                secretKeyRef:
                  name: sparta-app-secret
                  key: MONGO_URI
```

### Execution

The job was applied once:

```bash
kubectl apply -f mongo-seed-job.yaml
```

After completion:

```bash
kubectl get jobs -n sparta
```

Status:

```text
mongo-seed   1/1   Completed
```

## 8. Deploy Sparta Application

### 8.1 Create Application Secret

Create:

```bash
nano sparta-app-secret.yaml
```

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: sparta-app-secret
  namespace: sparta
type: Opaque
stringData:
  MONGO_URI: mongodb://admin:password123@mongo:27017/sparta?authSource=admin
```

![img](screenshoot/sparta-app-secret.png)

Apply:

```bash
sudo kubectl apply -f sparta-app-secret.yaml
```

### 8.2 Create Sparta Deployment

Create:

```bash
nano sparta-deployment.yaml
```

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: sparta-app
  namespace: sparta
spec:
  replicas: 2
  strategy:
    type: RollingUpdate
  selector:
    matchLabels:
      app: sparta-app
  template:
    metadata:
      labels:
        app: sparta-app
    spec:
      containers:
        - name: sparta-app
          image: jrodga1604/sparta-app:latest
          ports:
            - containerPort: 3000
          env:
            - name: DB_HOST
              valueFrom:
                secretKeyRef:
                  name: sparta-app-secret
                  key: MONGO_URI
          resources:
            requests:
              cpu: "100m"
              memory: "128Mi"
            limits:
              cpu: "250m"
              memory: "256Mi"
          livenessProbe:
            httpGet:
              path: /
              port: 3000
            initialDelaySeconds: 20
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /
              port: 3000
            initialDelaySeconds: 10
            periodSeconds: 5
```

![img](screenshoot/nano-sparta-deployment.png)

Apply:

```bash
sudo kubectl apply -f sparta-deployment.yaml
```

Verify:

```bash
sudo kubectl -n sparta get pods
```

![img](screenshoot/sparta-pods.png)

## 9. Expose Application

Create:

```bash
nano sparta-service.yaml
```

![img](screenshoot/nano-sparta-service.png)

Apply:

```bash
sudo kubectl apply -f sparta-service.yaml
```

Verify:

```bash
sudo kubectl -n sparta get svc
```

![img](screenshoot/sparta-svc.png)

## 10. Access Application

Open in a browser:

`http://EC2_PUBLIC_IP:30007`

![IMG](screenshoot/sparta-app-running.png)

Sparta app running successfully.

## 11. CI/CD Integration with Jenkins

### 11.1 Architecture Overview

We now integrate the Kubernetes deployment into Jenkins.

```text
GitHub -> Jenkins
         |
   Build Docker Image
         |
   Push to Docker Hub
         |
   SSH into EC2
         |
   kubectl set image
         |
   Rolling Update
```

### 11.2 Create New GitHub Repository

To avoid modifying the previous Docker-based project:

1. Create a new repository:

```text
sparta-project-1
```

2. Clone or copy the application into a new directory:

```bash
mkdir sparta-project-1
cd sparta-project-1
```

3. Push the project to GitHub:

```bash
git init
git add .
git commit -m "Initial Kubernetes migration"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/sparta-jenkins-kubernetes.git
git push -u origin main
```

![img](screenshoot/gtihub-new-rep.png)

### 11.3 Configure SSH Access to EC2

Jenkins must connect securely to EC2.

### Step 1 - Verify Manual SSH

From your local machine:

```bash
ssh -i ~/.ssh/your-key.pem ubuntu@EC2_PUBLIC_IP
```

If access is denied:

```bash
chmod 400 ~/.ssh/your-key.pem
```

Retry the connection.

![img](screenshoot/double-check-ssh-key.png)

### 11.4 Add SSH Key to Jenkins

Inside Jenkins:

```text
Manage Jenkins -> Credentials -> Global -> Add Credentials
```

Choose:

- Kind: **SSH Username with private key**
- Username: `ubuntu`
- Private Key: Paste contents of the `.pem` file
- ID: `ec2-ssh-key`

Save.

Note: Do not expose your private key.

![img](screenshoot/ssh-key.png)

### 11.5 Create Multibranch Pipeline

In Jenkins:

1. Click **New Item**
2. Name it:

```text
sparta-project-1
```

3. Select:

```text
Multibranch Pipeline
```

4. Configure:

- GitHub repository URL
- Credentials (GitHub access token)

5. Click **Save**

Jenkins will automatically scan branches.

![img](screenshoot/localhost_8080_view_all_job_sparta-project-1_configure.png)

### 11.6 Final Jenkinsfile

The `Jenkinsfile` includes:

- Docker build
- Docker push
- Kubernetes rolling update

```groovy
pipeline {
    agent any

    environment {
        IMAGE_NAME = "jrodga1604/sparta-app"
        EC2_HOST = "EC2_PUBLIC_IP"
    }

    stages {
        stage('Checkout') {
            steps {
                checkout scm
            }
        }

        stage('Build Docker Image') {
            steps {
                dir('app') {
                    sh """
                        docker buildx create --use --name multi-builder || true
                        docker buildx build \
                          --platform linux/amd64 \
                          -t ${IMAGE_NAME}:${BUILD_NUMBER} \
                          -t ${IMAGE_NAME}:latest \
                          --push .
                    """
                }
            }
        }

        stage('Deploy to Kubernetes') {
            when {
                branch 'main'
            }
            steps {
                sshagent(['ec2-ssh-key']) {
                    sh """
                    ssh -o StrictHostKeyChecking=no ubuntu@${EC2_HOST} '
                        sudo kubectl -n sparta set image deployment/sparta-app \
                        sparta-app=${IMAGE_NAME}:${BUILD_NUMBER}
                    '
                    """
                }
            }
        }
    }
}
```

Replace `EC2_PUBLIC_IP` with your actual EC2 public IP address.

## 12. User Guide

This section is intended for a user/tester who wants to verify the deployed application.

### How to Access the App

1. Open a browser.
2. Go to `http://EC2_PUBLIC_IP:30007`
3. Confirm the Sparta home page loads successfully.

### What to Test

- Homepage loads
- Navigation links work
- Posts page loads seeded data from MongoDB
- Fibonacci route responds correctly (if enabled in your app routes)

### Expected Behavior

- The app should remain available during rolling updates in Kubernetes.
- If a pod is restarted, Kubernetes should recreate it automatically.

## 13. CI/CD Pipeline Flow Summary

This project implements CI/CD for a containerized Node.js application deployed on a Kubernetes cluster running on an EC2 instance (IaaS).

### CI/CD Flow

1. Developer pushes code to GitHub.
2. Jenkins detects changes (Multibranch Pipeline).
3. Jenkins builds a new Docker image.
4. Jenkins pushes the image to Docker Hub.
5. Jenkins connects to the EC2 instance via SSH.
6. Jenkins updates the Kubernetes deployment image using `kubectl set image`.
7. Kubernetes performs a rolling update of the application pods.

### Why this meets the brief

- Uses Jenkins for automation
- Uses Docker for container image build/push
- Uses Kubernetes for deployment orchestration
- Deploys to a cloud VM (EC2) rather than a managed Kubernetes service

## 14. Contribution Guidelines

For future developers contributing to this project:

### Branching

- Create a feature branch from `main` (for example: `feature/update-readme`).
- Keep commits small and focused.
- Open a pull request with a clear summary of changes.

### Coding and Deployment Changes

- Test app changes locally before pushing.
- If changing the Docker image build, verify the `Dockerfile` and `Jenkinsfile` stay aligned.
- If changing Kubernetes manifests, validate YAML formatting before applying.
- Do not commit secrets, private keys, or real credentials.

### Documentation

- Update `README.md` when setup steps, pipeline behavior, or infrastructure configuration changes.
- Add screenshots only when they improve clarity.

## 15. Blockers and Resolutions

### Blocker 1: Docker image build failed for Kubernetes deployment from an M1 MacBook

#### Issue

The Jenkins/Docker build process required an image that runs on the EC2 Kubernetes node (`linux/amd64`), but development was done on an Apple Silicon (M1) MacBook (`arm64`).

Build command used:

```bash
docker buildx create --use --name multi-builder || true
docker buildx build \
  --platform linux/amd64 \
  -t ${IMAGE_NAME}:${BUILD_NUMBER} \
  -t ${IMAGE_NAME}:latest \
  --push .
```

#### Reason for the Issue

- M1 MacBooks use `arm64` architecture.
- The EC2 instance / Kubernetes node runs `amd64` (x86_64).
- A Docker image built only for `arm64` may fail to run on the EC2 node (`exec format error` or container startup failure).

#### Solution

- Use Docker Buildx and explicitly build for `linux/amd64`.
- Push the built image directly to Docker Hub from the pipeline.
- Reuse a named builder (`multi-builder`) to avoid recreating it every time.

#### Result

- The image became compatible with the EC2 Kubernetes environment.
- Jenkins could reliably build and deploy updated images to the cluster.

### Blocker 2: Database seeding timing in Kubernetes

#### Issue

The database seed script worked in the Docker-based setup but not automatically in Kubernetes.

#### Reason for the Issue

- The application image was built before MongoDB was available in-cluster.
- Seeding depended on a running database connection.

#### Solution

- Create an idempotent seed script.
- Run seeding as a Kubernetes Job after MongoDB starts.
- Add a wait step before the seed container runs.

## 16. What I Learned

- How to deploy a Node.js app to Kubernetes on an EC2 instance using K3s.
- How to store configuration and credentials using Kubernetes Secrets.
- How to persist MongoDB data using a PersistentVolumeClaim and StatefulSet.
- How to automate build and deployment stages with Jenkins.
- How rolling updates work in Kubernetes using `kubectl set image`.
- Why CPU architecture matters (`arm64` vs `amd64`) when building Docker images.

## 17. Benefits I Saw Personally

- Better understanding of how CI/CD works in a real deployment workflow.
- More confidence using Kubernetes resources beyond basic Deployments (Secrets, Services, StatefulSets, Jobs).
- Practical experience connecting multiple tools together (GitHub, Jenkins, Docker Hub, EC2, Kubernetes).
- Improved troubleshooting skills, especially for platform/architecture issues and deployment timing problems.

## 18. Next Steps (Amazon DocumentDB)

The next step is to move the database from in-cluster MongoDB to **Amazon DocumentDB** (MongoDB-compatible).

Why this is a good next step:

- It reduces operational overhead (AWS manages backups, patching, and failover).
- It improves durability and availability compared to a single MongoDB pod on one EC2 node.
- It separates application lifecycle from database lifecycle (cluster redeploys will not affect the database).
- It supports scaling the app more safely as the database becomes a managed service.
- It fits well with AWS networking/security controls (VPC, security groups, IAM-integrated operations).

Important note:

- DocumentDB is MongoDB-compatible, but not fully identical. Test application queries, indexes, and seed scripts before production migration.

Suggested migration path:

1. Create a DocumentDB cluster in the same VPC as the EC2/Kubernetes node(s).
2. Update the app secret (`MONGO_URI`) to point to DocumentDB.
3. Export/import existing MongoDB data.
4. Run application tests and verify read/write behavior.
5. Remove the in-cluster MongoDB StatefulSet after validation.

### Additional Future Improvement: EC2 IP Management for Jenkins

Currently, the Jenkins pipeline uses a fixed EC2 public IP (`EC2_HOST`) for SSH deployment.

Future improvement options:

- Use an **Elastic IP** so the deployment target address remains stable.
- Use **AWS CLI + IAM permissions** in Jenkins to fetch the EC2 IP dynamically by instance tag.

This would reduce manual updates in the `Jenkinsfile` if the EC2 instance is replaced or its public IP changes.




