# BaseOpenSDK(Node.js)
## 概述
[飞书开放平台](https://open.feishu.cn/document/server-docs/docs/bitable-v1/bitable-overview)提供了一系列服务端的原子api来实现多元化的功能，但在实际编码过程中感受不是很顺畅，原因在于使用这些api完成功能时，需要考虑很多额外的工作，如token的获取及其维护、数据加解密、请求的验签等等；再者，在实际编码过程中，少了函数调用的语义化描述，类型系统的支持，使得心智负担过重。

凡此种种，都使得整体的开发体验不佳，基于此，为了让开放能力变得易用，我们编写了该SDK，将所有冗长的逻辑内置处理，提供完备的类型系统，对外提供语义化的编程接口，提高编码体验。😙

## 概念
- 开发文档：开放平台的开放接口的参考，**开发者必看，可以使用搜索功能，高效的查询文档**。[更多介绍说明](https://open.feishu.cn/document/server-docs/docs/bitable-v1/bitable-overview) 。

## 安装
npm
```shell script
npm i -S https://lf3-static.bytednsdoc.com/obj/eden-cn/jjjpceh7nulojvhj/node-sdk-0.0.6.tgz
```

## 如何使用
提供ECMAScript，CommonJS2个版本，支持原生Javascript和Typescript的使用，示例均以Typescript为例。

SDK提供了语义化的调用方式，只需要依据相关参数构造出client实例，接着使用其上的语义化方法（*client.业务域.资源.方法*）即可完成api调用，调用过程及调用结果均有完备的类型进行提示，如列出 Base 数据表记录：
```typescript
import { BaseClient } from '@lark-base-open/node-sdk';

// 新建 BaseClient，贴上需要操作的 appToken 和 personalBaseToken
const client = new BaseClient({
  appToken: 'xxx',
  personalBaseToken: 'pt-xxxx'
});

// 列出数据表记录
const res = await client.base.appTableRecord.list({
  params: {
    page_size: 10,
  },
  path: {
    table_id: 'tblxxxxxx'
  }
});
```


#### `BaseClient`构造参数：
|  参数   | 描述  | 类型 | 必须 | 默认 |
|  ----  | ----  | ---- | ---- | ---- |
| appToken  | Base 应用唯一标识 | string | 是 | - |
| personalBaseToken  | Base 应用个人的鉴权 Token，从网页端获取 | string | 是 | - |
| domain  | 应用的域，分为飞书、lark、其它（需要传递完整的域名） | Domain &#124; string | 否 | Domain.Feishu |
| httpInstance | sdk发送请求的http实例。*sdk内部默认使用axios.create()构造出一个defaultHttpInstance来进行http调用。*| HttpInstance | 否 | defaultHttpInstance。*可以从sdk中import它，在其上添加interceptors来完成业务需求。* |
| loggerLevel  | 日志级别 | LoggerLevel | 否 | info |
| logger  | - | Logger | 否 | - |

#### 分页
针对返回值以分页形式呈现的接口，对其提供了迭代器方式的封装（方法名后缀为WithIterator），提高易用性，消弭了根据page_token来反复获取数据的繁琐操作，如获取数据表记录列表：
``` typescript
// 每次处理20条数据
for await (const data of await client.base.appTableRecord.listWithIterator({
  params: {
    page_size: 20,
  },
  path: {
    table_id: TABLEID
  }
})) {
  console.log(data?.items);
}
```
*当然也可以使用无迭代器封装的版本，这时候需要自己每次根据返回的page_token来手动进行分页调用。*
#### 文件上传
和调用普通api的方式一样，按类型提示传递参数即可，内部封装了对文件上传的处理，如：
```typescript
const filePath = path.resolve(__dirname, 'file.jpeg')

const data = await client.drive.media.uploadAll({
  data: {
    file_name: 'file.png', // 文件名
    parent_type: 'bitable_image', // bitable_image | bitable_file
    parent_node: client.appToken, // 填写 appToken
    size: fs.statSync(filePath).size, // 文件大小
    file: fs.createReadStream(filePath), // 文件流
  }
})
const fileToken = data.file_token;
```
#### 文件下载
对返回的二进制流进行了封装，消弭了对流本身的处理，只需调用writeFile方法即可将数据写入文件，如：
```typescript
const response = await client.drive.media.download({
  path: { file_token: 'xxx' },
  // 如果 Base 开启了高级权限，则需要填写 extra 参数
  params: { extra: JSON.stringify({
    "bitablePerm": {
      "tableId": 'tblxxx', // 资源所在数据表 Id
      "attachments": {
        "fldxxxxxxx": { // 资源所在数据表字段 Id
            "recxxxxxxx": [ // 资源所在数据表记录 Id
              "xxx" // 附件 file_token
            ]
        }
      }
    }
  }) }  
})
await response.writeFile(path.resolve(__dirname, 'file.png'));
```

#### 普通调用
某些老版本的开放接口，无法生成对应的语义化调用方法，需要使用client上的request方法来进行手动调用：
```typescript
import { BaseClient } from 'base-open-sdk';

const client = new BaseClient({
  appToken: 'xxx',
  personalBaseToken: 'pt-xxx'
});

const res = await client.request({
  method: 'POST',
  url: 'xxx',
  data: {},
  params: {},
});
```

## 许可协议
MIT

