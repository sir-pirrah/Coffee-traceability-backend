-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('SUPER_ADMIN', 'COOPERATIVE_ADMIN', 'COOPERATIVE_STAFF', 'FARMER', 'BUYER', 'AUDITOR');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'PENDING_VERIFICATION', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "BatchStatus" AS ENUM ('REGISTERED', 'IN_PROCESSING', 'PROCESSED', 'IN_STORAGE', 'IN_TRANSIT', 'SOLD', 'EXPORTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ProcessingMethod" AS ENUM ('WASHED', 'NATURAL', 'HONEY', 'SEMI_WASHED');

-- CreateEnum
CREATE TYPE "OwnershipTransferStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED');

-- CreateEnum
CREATE TYPE "BlockchainTxStatus" AS ENUM ('PENDING', 'CONFIRMED', 'FAILED');

-- CreateEnum
CREATE TYPE "BlockchainEventType" AS ENUM ('BATCH_CREATED', 'OWNERSHIP_TRANSFERRED', 'PROCESSING_COMPLETED', 'WAREHOUSE_STORED', 'SALE_RECORDED', 'QUALITY_GRADED');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'EMAIL', 'SMS');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'READ');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'LOGIN', 'LOGIN_FAILED', 'LOGOUT', 'EXPORT', 'VERIFY');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "phone_number" TEXT,
    "password_hash" TEXT NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "cooperative_id" UUID,
    "last_login_at" TIMESTAMP(3),
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "refresh_token_hash" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cooperatives" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "registration_no" TEXT,
    "county" TEXT NOT NULL,
    "sub_county" TEXT,
    "contact_email" TEXT,
    "contact_phone" TEXT,
    "address" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cooperatives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "farmers" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "cooperative_id" UUID NOT NULL,
    "farmer_code" TEXT NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "national_id" TEXT,
    "phone_number" TEXT,
    "farm_location" TEXT,
    "farm_size_acres" DECIMAL(8,2),
    "gps_latitude" DECIMAL(9,6),
    "gps_longitude" DECIMAL(9,6),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "farmers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deliveries" (
    "id" UUID NOT NULL,
    "delivery_code" TEXT NOT NULL,
    "farmer_id" UUID NOT NULL,
    "cooperative_id" UUID NOT NULL,
    "weight_kg" DECIMAL(10,2) NOT NULL,
    "quality_grade" TEXT,
    "moisture_level" DECIMAL(5,2),
    "price_per_kg" DECIMAL(10,2),
    "delivery_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "batch_id" UUID,

    CONSTRAINT "deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coffee_batches" (
    "id" UUID NOT NULL,
    "batch_code" TEXT NOT NULL,
    "cooperative_id" UUID NOT NULL,
    "status" "BatchStatus" NOT NULL DEFAULT 'REGISTERED',
    "total_weight_kg" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "origin_region" TEXT,
    "harvest_season" TEXT,
    "qr_code_token" TEXT NOT NULL,
    "current_owner_id" UUID,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coffee_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processing_records" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "method" "ProcessingMethod" NOT NULL,
    "processed_by_id" UUID,
    "start_date" TIMESTAMP(3) NOT NULL,
    "end_date" TIMESTAMP(3),
    "output_weight_kg" DECIMAL(10,2),
    "quality_notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "processing_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouses" (
    "id" UUID NOT NULL,
    "cooperative_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "location" TEXT,
    "capacity_kg" DECIMAL(12,2),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_inventory" (
    "id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "weight_kg" DECIMAL(12,2) NOT NULL,
    "stored_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMP(3),

    CONSTRAINT "warehouse_inventory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buyers" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "company_name" TEXT NOT NULL,
    "country" TEXT,
    "contact_email" TEXT,
    "contact_phone" TEXT,
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "buyers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ownership_transfers" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "from_entity_type" TEXT NOT NULL,
    "from_entity_id" UUID NOT NULL,
    "buyer_id" UUID,
    "initiated_by_id" UUID,
    "sale_price_per_kg" DECIMAL(10,2),
    "status" "OwnershipTransferStatus" NOT NULL DEFAULT 'PENDING',
    "transferred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ownership_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blockchain_transactions" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "event_type" "BlockchainEventType" NOT NULL,
    "tx_hash" TEXT,
    "payload_hash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "BlockchainTxStatus" NOT NULL DEFAULT 'PENDING',
    "error_message" TEXT,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMP(3),

    CONSTRAINT "blockchain_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qr_verifications" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "verified_ip" TEXT,
    "verified_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_agent" TEXT,

    CONSTRAINT "qr_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "channel" "NotificationChannel" NOT NULL DEFAULT 'IN_APP',
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "action" "AuditAction" NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_number_key" ON "users"("phone_number");

-- CreateIndex
CREATE INDEX "users_cooperative_id_idx" ON "users"("cooperative_id");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE UNIQUE INDEX "cooperatives_registration_no_key" ON "cooperatives"("registration_no");

-- CreateIndex
CREATE INDEX "cooperatives_county_idx" ON "cooperatives"("county");

-- CreateIndex
CREATE UNIQUE INDEX "farmers_user_id_key" ON "farmers"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "farmers_farmer_code_key" ON "farmers"("farmer_code");

-- CreateIndex
CREATE UNIQUE INDEX "farmers_national_id_key" ON "farmers"("national_id");

-- CreateIndex
CREATE INDEX "farmers_cooperative_id_idx" ON "farmers"("cooperative_id");

-- CreateIndex
CREATE INDEX "farmers_farmer_code_idx" ON "farmers"("farmer_code");

-- CreateIndex
CREATE UNIQUE INDEX "deliveries_delivery_code_key" ON "deliveries"("delivery_code");

-- CreateIndex
CREATE INDEX "deliveries_farmer_id_idx" ON "deliveries"("farmer_id");

-- CreateIndex
CREATE INDEX "deliveries_cooperative_id_idx" ON "deliveries"("cooperative_id");

-- CreateIndex
CREATE INDEX "deliveries_delivery_date_idx" ON "deliveries"("delivery_date");

-- CreateIndex
CREATE INDEX "deliveries_batch_id_idx" ON "deliveries"("batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "coffee_batches_batch_code_key" ON "coffee_batches"("batch_code");

-- CreateIndex
CREATE UNIQUE INDEX "coffee_batches_qr_code_token_key" ON "coffee_batches"("qr_code_token");

-- CreateIndex
CREATE INDEX "coffee_batches_cooperative_id_idx" ON "coffee_batches"("cooperative_id");

-- CreateIndex
CREATE INDEX "coffee_batches_status_idx" ON "coffee_batches"("status");

-- CreateIndex
CREATE INDEX "coffee_batches_qr_code_token_idx" ON "coffee_batches"("qr_code_token");

-- CreateIndex
CREATE INDEX "processing_records_batch_id_idx" ON "processing_records"("batch_id");

-- CreateIndex
CREATE INDEX "warehouses_cooperative_id_idx" ON "warehouses"("cooperative_id");

-- CreateIndex
CREATE INDEX "warehouse_inventory_warehouse_id_idx" ON "warehouse_inventory"("warehouse_id");

-- CreateIndex
CREATE INDEX "warehouse_inventory_batch_id_idx" ON "warehouse_inventory"("batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "buyers_user_id_key" ON "buyers"("user_id");

-- CreateIndex
CREATE INDEX "ownership_transfers_batch_id_idx" ON "ownership_transfers"("batch_id");

-- CreateIndex
CREATE INDEX "ownership_transfers_buyer_id_idx" ON "ownership_transfers"("buyer_id");

-- CreateIndex
CREATE UNIQUE INDEX "blockchain_transactions_tx_hash_key" ON "blockchain_transactions"("tx_hash");

-- CreateIndex
CREATE INDEX "blockchain_transactions_batch_id_idx" ON "blockchain_transactions"("batch_id");

-- CreateIndex
CREATE INDEX "blockchain_transactions_event_type_idx" ON "blockchain_transactions"("event_type");

-- CreateIndex
CREATE INDEX "blockchain_transactions_status_idx" ON "blockchain_transactions"("status");

-- CreateIndex
CREATE INDEX "qr_verifications_batch_id_idx" ON "qr_verifications"("batch_id");

-- CreateIndex
CREATE INDEX "qr_verifications_verified_at_idx" ON "qr_verifications"("verified_at");

-- CreateIndex
CREATE INDEX "notifications_user_id_idx" ON "notifications"("user_id");

-- CreateIndex
CREATE INDEX "notifications_status_idx" ON "notifications"("status");

-- CreateIndex
CREATE INDEX "audit_logs_user_id_idx" ON "audit_logs"("user_id");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_cooperative_id_fkey" FOREIGN KEY ("cooperative_id") REFERENCES "cooperatives"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "farmers" ADD CONSTRAINT "farmers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "farmers" ADD CONSTRAINT "farmers_cooperative_id_fkey" FOREIGN KEY ("cooperative_id") REFERENCES "cooperatives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_farmer_id_fkey" FOREIGN KEY ("farmer_id") REFERENCES "farmers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_cooperative_id_fkey" FOREIGN KEY ("cooperative_id") REFERENCES "cooperatives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "coffee_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coffee_batches" ADD CONSTRAINT "coffee_batches_cooperative_id_fkey" FOREIGN KEY ("cooperative_id") REFERENCES "cooperatives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processing_records" ADD CONSTRAINT "processing_records_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "coffee_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processing_records" ADD CONSTRAINT "processing_records_processed_by_id_fkey" FOREIGN KEY ("processed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_cooperative_id_fkey" FOREIGN KEY ("cooperative_id") REFERENCES "cooperatives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_inventory" ADD CONSTRAINT "warehouse_inventory_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_inventory" ADD CONSTRAINT "warehouse_inventory_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "coffee_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buyers" ADD CONSTRAINT "buyers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ownership_transfers" ADD CONSTRAINT "ownership_transfers_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "coffee_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ownership_transfers" ADD CONSTRAINT "ownership_transfers_buyer_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "buyers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ownership_transfers" ADD CONSTRAINT "ownership_transfers_initiated_by_id_fkey" FOREIGN KEY ("initiated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blockchain_transactions" ADD CONSTRAINT "blockchain_transactions_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "coffee_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qr_verifications" ADD CONSTRAINT "qr_verifications_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "coffee_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
