// Comprehensive seed template for Coffee Traceability System.
// NOTE: Generated skeleton. Extend with additional records as needed.
import { PrismaClient, UserRole, UserStatus, BatchStatus, ProcessingMethod, BlockchainEventType, BlockchainTxStatus } from "@prisma/client";
import bcrypt from "bcrypt";
import { DEFAULT_ROLE_PERMISSIONS } from "../src/constants/permissions";
const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash("ChangeMe!2026",12);

  // Global settings singleton — maintenance off by default.
  await prisma.systemSetting.upsert({
    where:{id:"singleton"},
    update:{},
    create:{id:"singleton",maintenanceMode:false}
  });

  // Seed the permission matrix from the code-defined defaults (idempotent).
  for (const [role, permissions] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
    for (const permission of permissions) {
      await prisma.rolePermission.upsert({
        where:{role_permission:{role:role as UserRole,permission}},
        update:{},
        create:{role:role as UserRole,permission}
      });
    }
  }

  const cooperative = await prisma.cooperative.upsert({
    where:{registrationNo:"COOP-0001"},
    update:{},
    create:{
      name:"Nyeri Highlands Coffee Cooperative",
      registrationNo:"COOP-0001",
      county:"Nyeri",
      subCounty:"Mathira",
      contactEmail:"info@coffeetrace.com",
      contactPhone:"+254700000001",
      address:"Karatina"
    }
  });

  const roles = [
    ["superadmin@coffeetrace.com","System","Admin",UserRole.SUPER_ADMIN],
    ["coopadmin@coffeetrace.com","Coop","Admin",UserRole.COOPERATIVE_ADMIN],
    ["staff@coffeetrace.com","John","Staff",UserRole.COOPERATIVE_STAFF],
    ["farmer@coffeetrace.com","Peter","Farmer",UserRole.FARMER],
    ["buyer@coffeetrace.com","Global","Buyer",UserRole.BUYER],
    ["auditor@coffeetrace.com","Quality","Auditor",UserRole.AUDITOR],
  ] as const;

  const users:any = {};
  for (const [email,first,last,role] of roles){
    const maintenanceAllowed = role === UserRole.SUPER_ADMIN;
    users[email]=await prisma.user.upsert({
      where:{email},
      update:{maintenanceAllowed},
      create:{
        email,passwordHash,firstName:first,lastName:last,
        role,status:UserStatus.ACTIVE,maintenanceAllowed,
        cooperativeId:cooperative.id
      }
    });
  }

  const farmer = await prisma.farmer.upsert({
    where:{farmerCode:"FRM0001"},
    update:{},
    create:{
      farmerCode:"FRM0001",
      firstName:"Peter",
      lastName:"Farmer",
      userId:users["farmer@coffeetrace.com"].id,
      cooperativeId:cooperative.id,
      phoneNumber:"0712345678",
      farmLocation:"Mathira",
      farmSizeAcres:3.5
    }
  });

  await prisma.buyer.upsert({
    where:{userId:users["buyer@coffeetrace.com"].id},
    update:{},
    create:{
      userId:users["buyer@coffeetrace.com"].id,
      companyName:"Global Coffee Exporters Ltd",
      country:"Germany",
      contactEmail:"buyer@coffeetrace.com",
      isVerified:true
    }
  });

  // Tolerates a re-run: Warehouse has no natural unique key to upsert on, so a
  // second seed just leaves the existing row alone.
  await prisma.warehouse.create({
    data:{
      cooperativeId:cooperative.id,
      name:"Main Warehouse",
      location:"Karatina",
      capacityKg:50000
    }
  }).catch(()=>null);

  const batch = await prisma.coffeeBatch.upsert({
    where:{batchCode:"BATCH-0001"},
    update:{},
    create:{
      batchCode:"BATCH-0001",
      cooperativeId:cooperative.id,
      qrCodeToken:"QR-BATCH-0001",
      status:BatchStatus.REGISTERED,
      totalWeightKg:2500,
      originRegion:"Nyeri",
      harvestSeason:"2026"
    }
  });

  await prisma.delivery.upsert({
    where:{deliveryCode:"DEL-0001"},
    update:{},
    create:{
      deliveryCode:"DEL-0001",
      farmerId:farmer.id,
      cooperativeId:cooperative.id,
      batchId:batch.id,
      weightKg:250,
      qualityGrade:"AA",
      moistureLevel:10.5,
      pricePerKg:145
    }
  });

  await prisma.processingRecord.create({
    data:{
      batchId:batch.id,
      method:ProcessingMethod.WASHED,
      processedById:users["staff@coffeetrace.com"].id,
      startDate:new Date(),
      outputWeightKg:220
    }
  }).catch(()=>{});

  await prisma.blockchainTransaction.create({
    data:{
      batchId:batch.id,
      eventType:BlockchainEventType.BATCH_CREATED,
      payloadHash:"samplehash",
      payload:{batch:"BATCH-0001"},
      status:BlockchainTxStatus.CONFIRMED,
      txHash:"0xsampletxhash"
    }
  }).catch(()=>{});

  console.log("Seed completed.");
  console.log("Password for all users: ChangeMe!2026");
}

main().finally(()=>prisma.$disconnect());