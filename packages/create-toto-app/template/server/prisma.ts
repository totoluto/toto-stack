import {PrismaClient} from "@prismaClient/client";
import {PrismaMariaDb} from "@prisma/adapter-mariadb";

const adapter = new PrismaMariaDb({
    host: process.env.MYSQL_HOST,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    port: Number(process.env.MYSQL_PORT) || 3306,
    connectionLimit: 5,
});

const prisma = new PrismaClient({adapter});
export default prisma;
