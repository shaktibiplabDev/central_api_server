# Mobile App API Documentation v1.2

This document provides complete integration details for the **Central API Server**.  
It includes user management, authentication, wallet functions, and multiple form submissions with file uploads.

---

## Base URL & Authentication

**Base URL:**  
```
https://api.yourdomain.com
```

### Authentication
Most endpoints require a **JWT (JSON Web Token)**.

1. A user logs in using `POST /api/login` to receive a token.  
2. This token must be included in the `Authorization` header in every protected request.

**Header Example:**
```
Authorization: Bearer <your_jwt_token_here>
```

---

## Public Endpoints

### Get App Version Information
**Endpoint:**  
```
GET /api/app-info
```

**Description:**  
Retrieves the latest version details for the application.

**Sample Request (cURL):**
```bash
curl -X GET https://api.yourdomain.com/api/app-info
```

**Success Response (200 OK):**
```json
{
  "latestVersion": "1.2.0",
  "forceUpdateBelow": "1.2.0",
  "downloadUrl": "https://api.yourdomain.com/downloads/app-v1.2.0.apk"
}
```

---

## Authentication Endpoints

### Register a New User
**Endpoint:**  
```
POST /api/register
```

**Description:**  
Registers a new user and validates their license + website association.

**Sample Request (cURL):**
```bash
curl -X POST https://api.yourdomain.com/api/register   -H "Content-Type: application/json"   -d '{
    "email": "user@clientwebsite.com",
    "password": "their-website-password",
    "userLicenseKey": "USER-WHMCS-KEY",
    "websiteUrl": "https://clientwebsite.com"
  }'
```

**Success Response (201 Created):**
```json
{
  "message": "Registration successful.",
  "userId": 1,
  "websiteStatus": "approved"
}
```

**Error Response (400 Bad Request):**
```json
{
  "error": "Email already registered."
}
```

---

### Log In a User
**Endpoint:**  
```
POST /api/login
```

**Description:**  
Authenticates a user and returns a JWT. Also synchronizes their password if it has changed.

**Sample Request (cURL):**
```bash
curl -X POST https://api.yourdomain.com/api/login   -H "Content-Type: application/json"   -d '{
    "email": "user@clientwebsite.com",
    "password": "their-website-password"
  }'
```

**Success Response (200 OK):**
```json
{
  "message": "Login successful",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Error Response (401 Unauthorized):**
```json
{
  "error": "Invalid credentials."
}
```

---

## Protected Endpoints

### Get User Profile
**Endpoint:**  
```
GET /api/profile
```

**Sample Request (cURL):**
```bash
curl -X GET https://api.yourdomain.com/api/profile   -H "Authorization: Bearer <your_jwt_token_here>"
```

**Success Response (200 OK):**
```json
{
  "userId": 1,
  "email": "user@clientwebsite.com",
  "websiteStatus": "approved"
}
```

**Error Response (401 Unauthorized):**
```json
{
  "error": "Token expired or invalid."
}
```

---

### Get User Wallet Balance
**Endpoint:**  
```
GET /api/user/wallet
```

**Sample Request (cURL):**
```bash
curl -X GET https://api.yourdomain.com/api/user/wallet   -H "Authorization: Bearer <your_jwt_token_here>"
```

**Success Response (200 OK):**
```json
{
  "balance": 150.75,
  "bonus_balance": 0.00,
  "currency": "₹"
}
```

**Error Response (403 Forbidden):**
```json
{
  "error": "Website not approved."
}
```

---

## Form Submission Guide

All form submissions must be sent as **multipart/form-data**.  
This allows text fields and file uploads in the same request.

**General Endpoint:**  
```
POST /api/forms/:formType
```

**General Success Response (200 OK):**
```json
{
  "message": "Form processed successfully.",
  "data": {
    "message": "Child enrollment successful!",
    "applicationId": "CHILD-20250918-ABCDE",
    "newBalance": 9900.00
  }
}
```

**General Error Responses:**
- 400 Bad Request → Missing or invalid data  
- 401 Unauthorized → Invalid/missing JWT  
- 402 Payment Required → Insufficient wallet balance  
- 403 Forbidden → Website not approved  
- 404 Not Found → Invalid form type  

---

## Form Types

### 1. Child Enrollment
**Endpoint:**  
```
POST /api/forms/childEnrollment
```

**Required Fields:**  
child_name, child_dob (YYYY-MM-DD), child_gender, child_birthplace, guardian_name, guardian_relation, guardian_aadhar, guardian_mobile, address_line1, city, district, state, pincode, birth_certificate (file), guardian_id_proof_file (file), child_photo (file), fingerprints (array).  

Optional: missing_fingers (array).  

**Sample Request (cURL):**
```bash
curl -X POST https://api.yourdomain.com/api/forms/childEnrollment   -H "Authorization: Bearer <your_jwt_token_here>"   -F "child_name=Rahul Kumar"   -F "child_dob=2015-03-10"   -F "child_gender=Male"   -F "guardian_name=Anil Kumar"   -F "guardian_relation=Father"   -F "guardian_aadhar=123412341234"   -F "guardian_mobile=9876543210"   -F "address_line1=123 Main Street"   -F "city=Delhi"   -F "district=New Delhi"   -F "state=Delhi"   -F "pincode=110001"   -F "birth_certificate=@/path/birth_cert.pdf"   -F "guardian_id_proof_file=@/path/id_proof.png"   -F "child_photo=@/path/child.png"   -F "fingerprints[]=@/path/fingerprint1.png"
```

**Success Response (200 OK):**
```json
{
  "message": "Form processed successfully.",
  "data": {
    "message": "Child enrollment successful!",
    "applicationId": "CHILD-20250918-ABCDE",
    "newBalance": 9900.00
  }
}
```

---

### 2. Address Update
**Endpoint:**  
```
POST /api/forms/addressUpdate
```

**Required Fields:**  
full_name, aadhaar_no, village, district, mobile_no, post, state, pincode, purpose, document (file), fingerprints (array).  

**Sample Request (cURL):**
```bash
curl -X POST https://api.yourdomain.com/api/forms/addressUpdate   -H "Authorization: Bearer <your_jwt_token_here>"   -F "full_name=Rahul Kumar"   -F "aadhaar_no=123412341234"   -F "village=Kalyanpur"   -F "district=Patna"   -F "mobile_no=9876543210"   -F "post=Post Office"   -F "state=Bihar"   -F "pincode=800001"   -F "purpose=ADDRESS UPDATE"   -F "document=@/path/document.pdf"   -F "fingerprints[]=@/path/fingerprint1.png"
```

**Success Response (200 OK):**
```json
{
  "message": "Form processed successfully.",
  "data": {
    "message": "Address update successful.",
    "applicationId": "ADDR-20250918-XYZ12",
    "newBalance": 9850.00
  }
}
```

---

### 3. Date of Birth Update
**Endpoint:**  
```
POST /api/forms/dobUpdate
```

**Required Fields:**  
full_name, aadhaar_no, village, district, mobile_no, old_dob, new_dob, father_name, post, state, pincode, purpose, photo (file), documents (file), fingerprints (array).  

---

### 4. Mobile/Email Update
**Endpoint:**  
```
POST /api/forms/mobileEmailUpdate
```

**Required Fields:**  
full_name, mobile_no, email_id, purpose, aadhar_no, fingerprints (array).  
Optional: father_name.  

---

### 5. Name Update
**Endpoint:**  
```
POST /api/forms/nameUpdate
```

**Required Fields:**  
old_name, new_name, father_name, dob, aadhaar_no, purpose, pincode, village_town, district, candidate_photo (file), supporting_document (file), fingerprints (array).  

---

## Notes for Developers
- Always send form data as `multipart/form-data`.  
- Aadhaar must be 12 digits.  
- Mobile numbers must be 10 digits.  
- Dates must follow `YYYY-MM-DD` format.  
- Handle error responses gracefully and display meaningful messages to users.
