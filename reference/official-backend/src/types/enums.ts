export enum NumberFormatter {
  Integer = '0',
  OneDecimal = '0.0',
  TwoDecimals = '0.00',
  ThreeDecimals = '0.000',
  FourDecimals = '0.0000',
  Thousands = '1,000',
  ThousandsWithDecimals = '1,000.00',
  Percentage = '%',
  PercentageWithDecimals = '0.00%',
  RMB = '¥',
  RMBWithDecimals = '¥0.00',
  USD = '$',
  USDWithDecimals = '$0.00',
}

export enum ProgressNumberFormatter {
  Integer = '0',
  OneDecimal = '0.0',
  TwoDecimals = '0.00',
  IntegerPercentage = '0%',
  OneDecimalPercentage = '0.0%',
  TwoDecimalPercentage = '0.00%',
}

export enum CurrencyCode {
  CNY = 'CNY', // ¥
  USD = 'USD', // $
  EUR = 'EUR', // €
  GBP = 'GBP', // £
  AED = 'AED', // dh
  AUD = 'AUD', // $
  BRL = 'BRL', // R$
  CAD = 'CAD', // $
  CHF = 'CHF', // CHF
  HKD = 'HKD', // $
  INR = 'INR', // ₹
  IDR = 'IDR', // Rp
  JPY = 'JPY', // ¥
  KRW = 'KRW', // ₩
  MOP = 'MOP', // MOP$
  MXN = 'MXN', // $
  MYR = 'MYR', // RM
  PHP = 'PHP', // ₱
  PLN = 'PLN', // zł
  RUB = 'RUB', // ₽
  SGD = 'SGD', // $
  THB = 'THB', // ฿
  TRY = 'TRY', // ₺
  TWD = 'TWD', // NT$
  VND = 'VND', // ₫
}

export enum CurrencyPrecision {
  Integer = '0',
  OneDecimal = '0.0',
  TwoDecimals = '0.00',
  ThreeDecimals = '0.000',
  FourDecimals = '0.0000',
}

export enum FieldType {
  NotSupport = 0,
  Text = 1,
  Number = 2,
  SingleSelect = 3,
  MultiSelect = 4,
  DateTime = 5,
  // 暂未实现
  // SingleLine = 6,
  Checkbox = 7,
  // Percent = 8,
  // Duration = 9,
  // Rating = 10,
  User = 11,
  // Tag = 12,
  Phone = 13,
  // Email = 14,
  Url = 15,
  // Picture = 16,
  Attachment = 17,
  SingleLink = 18,
  Lookup = 19,
  Formula = 20,
  // 双向关联
  DuplexLink = 21,
  // 地理位置
  Location = 22,
  // 群组
  GroupChat = 23,
  // 阶段
  Stage = 24,
  // Object 字段
  Object = 25,
  // 高级权限下不可见的列
  Denied = 403,

  /**
   * 引用类型字段，前后端约定用10xx公共前缀开头
   */
  CreatedTime = 1001,
  ModifiedTime = 1002,
  CreatedUser = 1003,
  ModifiedUser = 1004,
  // 自动编号
  AutoNumber = 1005,
  // 按钮字段
  VirtualTrigger = 3001, // 仅含 meta，不含 cellValue 的字段
}

export enum RatingSymbol {
  Star = 'star',
  Heart = 'heart',
  ThumbsUp = 'thumbsup',
  Fire = 'fire',
  Smile = 'smile',
  Lightning = 'lightning',
  Flower = 'flower',
  Number = 'number',
}

export enum DateFormatter {
  /**
   * Format: 2021/1/30
   */
  YYYY_MM_DD = 'yyyy/MM/dd',

  /**
   * Format: 2021-1-30 14:00
   */
  YYYY_MM_DD_HH_MM = 'yyyy-MM-dd HH:mm',

  /**
   * Format: 1月30日
   */
  MM_DD = 'MM-dd',

  /**
   * Format: 1/30/2020
   */
  MM_DD_YYYY = 'MM/dd/yyyy',

  /**
   * Format: 30/1/2021
   */
  DD_MM_YYYY = 'dd/MM/yyyy',
}

export enum FormulaDateFormatter {
  /**
   * Format: 2021-1-30 14:00
   */
  YYYY_MM_DD_HH_MM = 'yyyy-MM-dd HH:mm',

  YYYY_MM_DD = 'yyyy/MM/dd',
  YYYY_MM_DD2 = 'yyyy-MM-dd',
  /**
   * Format: 1月30日
   */
  MM_DD = 'MM-dd',
}
