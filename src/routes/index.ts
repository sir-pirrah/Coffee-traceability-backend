import { Router } from "express";
import authRoutes from "@/modules/auth/auth.routes";
import userRoutes from "@/modules/users/user.routes";
import cooperativeRoutes from "@/modules/cooperatives/cooperative.routes";
import farmerRoutes from "@/modules/farmers/farmer.routes";
import deliveryRoutes from "@/modules/deliveries/delivery.routes";
import coffeeBatchRoutes from "@/modules/coffeeBatches/coffeeBatch.routes";
import processingRoutes from "@/modules/processing/processing.routes";
import warehouseRoutes from "@/modules/warehouses/warehouse.routes";
import buyerRoutes from "@/modules/buyers/buyer.routes";
import ownershipTransferRoutes from "@/modules/ownershipTransfers/ownershipTransfer.routes";
import notificationRoutes from "@/modules/notifications/notification.routes";
import reportRoutes from "@/modules/reports/report.routes";
import permissionRoutes from "@/modules/permissions/permission.routes";
import systemRoutes from "@/modules/system/system.routes";

const router = Router();

router.use("/auth", authRoutes);
router.use("/users", userRoutes);
router.use("/cooperatives", cooperativeRoutes);
router.use("/farmers", farmerRoutes);
router.use("/deliveries", deliveryRoutes);
router.use("/batches", coffeeBatchRoutes);
router.use("/processing", processingRoutes);
router.use("/warehouses", warehouseRoutes);
router.use("/buyers", buyerRoutes);
router.use("/ownership-transfers", ownershipTransferRoutes);
router.use("/notifications", notificationRoutes);
router.use("/reports", reportRoutes);
router.use("/permissions", permissionRoutes);
router.use("/system", systemRoutes);

export default router;
