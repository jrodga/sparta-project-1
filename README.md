##
# 1. Project Objective

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

- ClusterIP service for internal networking
##
# 2. Final Architecture

```text
Jenkins → Docker Hub → EC2 (k3s)
                          │
            ┌─────────────┴─────────────┐
            │                           │
     Sparta Deployment (2 Pods)     Mongo StatefulSet (1 Pod)
            │                           │
     NodePort Service (30007)      ClusterIP Service
                                        │
                               PersistentVolumeClaim

```
##
# 3. Prerequisites

- Ubuntu 22.04 EC2 instance (stable version)
    - Recomended t2.small (minimun 2GB RAM)


Security group inbound rules:

    - 22 (SSH)

    - 30007 (NodePort access from browser/test machine)
    
![alt text](screenshoot/ec2-sg.png)
##
# 4. Install k3s on EC2

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

- STATUS: `Ready`

![alt text](screenshoot/k3s-installation.png)
##
# 5. Create Kubernetes Namespace

Using a namespace keeps resources organized.
```bash
sudo kubectl create namespace sparta
```
![alt text](screenshoot/namespace.png)


double check it was created 

```bash
sudo kubectl get ns
```


![alt text](screenshoot/get-namespace.png)
##
# 6. Create Project Directory

All Kubernetes YAML files will be created on the EC2 instance.

Create folder:
```bash
mkdir sparta-k8s
cd sparta-k8s
```

This keeps configuration organized and professional.
# 7. Deploy MongoDB (Stateful + Persistent)

### 7.1 Create MongoDB Secret (Credentials)

This file is created on the EC2 instance inside `sparta-k8s`.

Create file:

```bash
nano mongo-secret.yaml
```

use:

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

save:
- CTRL+X
- Y
- Eneter

Apply:
```bash
sudo kubectl apply -f mongo-secret.yaml
```

verify:
```bash
sudo kubectl -n sparta get secrets
```

![img](screenshoot/apply-secret.png)
##
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

Status should be `Bound`.(will happen after we apply later `StatefulSet`)
![alt text](screenshoot/persisten-volume-claim.png)

##
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
##
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

##
# 8. Deploy Sparta Application
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
            - name: MONGO_URI
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
![img](screenshoot/sparta-deployment.png)

Apply:
```bash
sudo kubectl apply -f sparta-deployment.yaml
```

Verify:
```bash
sudo kubectl -n sparta get pods
```
![img](screenshoot/sparta-pods.png)

##
# 9. Expose Application

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
##
# 10. Access Application

Open browser:

`http://EC2_PUBLIC_IP:30007`

![IMG](screenshoot/sparta-app-running.png)

Sparta app running successfully!!!

