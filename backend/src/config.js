export const config = {
  port: Number(process.env.PORT || 7103),
  // mysql（生产/compose） | sqlite（本地开发与测试，零依赖）
  dbDialect: process.env.DB_DIALECT || 'mysql',
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'root123456',
    name: process.env.DB_NAME || 'patent_cloud',
  },
  sqliteFile: process.env.SQLITE_FILE || ':memory:',
  // redis://... | memory://（本地开发与测试）
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  tokenTtlSec: Number(process.env.TOKEN_TTL_SEC || 12 * 3600),
  seedOnBoot: process.env.SEED_ON_BOOT !== 'false',
  bcryptRounds: Number(process.env.BCRYPT_ROUNDS || 10),
  // 代理所所在地时区：期限日期按此时区解释「今天/剩几天/是否逾期」。
  // 存储一律 UTC/日历日字符串，跨时区展示由前端按此时区换算。
  firmTz: process.env.FIRM_TZ || 'Asia/Shanghai',
  // 撰稿附件原件对象存储：当前内置 local（compose 挂卷 / 本地 .objectstore 目录），
  // 原件只存对象存储不入库；object_key 不可变，附件换版旧版仍可打开。s3 为预留 seam。
  objectStoreDriver: process.env.OBJECT_STORE_DRIVER || 'local',
  objectStoreDir: process.env.OBJECT_STORE_DIR || './.objectstore',
}
