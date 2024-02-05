# uni-asynchronous-subcontracting
> uniapp小程序组件分包异步化

## 1、需求描述
### 1.1 需求描述
在小程序中，不同的分包对应不同的下载单元；因此，除了非独立分包可以依赖主包外，分包之间不能互相使用自定义组件或进行 require。「分包异步化」特性将允许通过一些配置和新的接口，使部分跨分包的内容可以等待下载后异步使用，从而一定程度上解决这个限制。
### 1.2 需求背景
- uni框架下小程序分包之间不能互相使用自定义组件
- uni框架下主包无法使用分包自定义组件
- 主包体积超出

## 2、功能使用
### 2.1 页面级使用分包组件（丢弃）
```
{
    path: 'pages/******/index',
    style: {
      ...,
      componentPlaceholder: {
        'popup': 'view',
      },
      usingComponents: {
        'popup': '/minePackage/components/popup/index',
      },
    },
}
```
### 2.2 页面级&自定义组件级使用分包组件
#### 2.2.1、在组件components注册同级设置asyncCustomComponents
```
asyncCustomComponents: {
    'item': '/minePackage/components/item/index',
    'loading': '/minePackage/components/loading/index',
}
```
#### 2.2.2、直接使用对应组件
```
<item />
<loading />
```
## 3、技术方案
> 目前页面级的配置已经支持，此源码改造只针对自定义组件（主包或者分包）引用分包组件的问题

### 3.1 源码方向
#### 3.1.1 uni源码改造
- 1、通过 @babel/traverse 遍历、修改 AST 语法树的各个节点，获取到组件中配置的asyncCustomComponents，外透出去。
```
node_modules/@dcloudio/webpack-uni-mp-loader/lib/babel/scoped-component-traverse.js

function handleObjectExpression (declaration, path, state) {
  if (state.options) { // name,inheritAttrs,props
    Object.keys(state.options).forEach(name => {
      const optionProperty = declaration.properties.filter(prop => {
        return t.isObjectProperty(prop) &&
          t.isIdentifier(prop.key) &&
          prop.key.name === name
      })[0]
      if (optionProperty) {
        if (name === 'props') {
          if (t.isArrayExpression(optionProperty.value)) {
            state.options[name] = JSON.stringify(optionProperty.value.elements.filter(element => t.isStringLiteral(
              element)).map(({
              value
            }) => value))
          } else if (t.isObjectExpression(optionProperty.value)) {
            const props = []
            optionProperty.value.properties.forEach(({
              key
            }) => {
              if (t.isIdentifier(key)) {
                props.push(key.name)
              } else if (t.isStringLiteral(key)) {
                props.push(key.value)
              }
            })
            state.options[name] = JSON.stringify(props)
          }
        } else if (t.isStringLiteral(optionProperty.value)) {
          state.options[name] = JSON.stringify(optionProperty.value.value)
        } else {
          state.options[name] = optionProperty.value.value
        }
      }
    })
  }
  const componentsProperty = declaration.properties.filter(prop => {
    return t.isObjectProperty(prop) &&
      t.isIdentifier(prop.key) &&
      prop.key.name === 'components'
  })[0]
  // ----------------------(新增)
  const asyncCustomComponentsProperty = declaration.properties.filter(prop => {
    return t.isObjectProperty(prop) &&
      t.isIdentifier(prop.key) &&
      prop.key.name === 'asyncCustomComponents'
  })[0]
  if(asyncCustomComponentsProperty) {
    handleAsyncCustomComponentsObjectExpression(asyncCustomComponentsProperty.value, path, state)
  }
  // ----------------------
  if (componentsProperty && t.isObjectExpression(componentsProperty.value)) {
    handleComponentsObjectExpression(componentsProperty.value, path, state)
  }
}

// ----------------------(新增)
function handleAsyncCustomComponentsObjectExpression(componentsObjExpr, path, state) {
  const properties = componentsObjExpr.properties
  console.log('[properties]', properties);
  const asyncCustomComponentsDeclaration = properties.map(prop => {
    return {
      name: prop.key.name || prop.key.value,
      value: prop.value.value
    }
  })
  state.asyncCustomComponents = asyncCustomComponentsDeclaration
}
// ----------------------
```
- 2、通过上面traverse解析外透的asyncCustomComponents，透传到updateUsingComponents
```
node_modules/@dcloudio/webpack-uni-mp-loader/lib/script-new.js

module.exports = function (content, map) {
  this.cacheable && this.cacheable()

  content = preprocessor.preprocess(content, jsPreprocessOptions.context, {
    type: jsPreprocessOptions.type
  })

  let resourcePath = normalizeNodeModules(removeExt(normalizePath(path.relative(process.env.UNI_INPUT_DIR, this
    .resourcePath))))

  let type = ''
  if (resourcePath === 'App') {
    type = 'App'
  } else if (process.UNI_ENTRY[resourcePath]) {
    type = 'Page'
  }
  // <script src=""/>
  if (!type && this._module.issuer && this._module.issuer.issuer) {
    resourcePath = normalizeNodeModules(removeExt(normalizePath(path.relative(process.env.UNI_INPUT_DIR, this._module
      .issuer.issuer.resource))))
    if (resourcePath === 'App') {
      type = 'App'
    } else if (process.UNI_ENTRY[resourcePath]) {
      type = 'Page'
    }
  }

  if ( // windows 上 page-meta, navigation-bar 可能在不同盘上
    /^win/.test(process.platform) &&
    path.isAbsolute(resourcePath) &&
    isBuiltInComponentPath(resourcePath)
  ) {
    resourcePath = normalizePath(path.relative(process.env.UNI_CLI_CONTEXT, resourcePath))
  }

  if (!type) {
    type = 'Component'
  }

  const {
    state: {
      components,
    // ----------------------(新增)
      asyncCustomComponents,
    // ----------------------
    }
  } = traverse(parser.parse(content, getBabelParserOptions()), {
    type,
    components: []
  })

  const callback = this.async()

  if (!components.length) {
    if (type === 'App') {
      callback(null, content, map)
      return
    }
    // 防止组件从有到无，App.vue 中不支持使用组件
    updateUsingComponents(resourcePath, Object.create(null), type, asyncCustomComponents)
    callback(null, content, map)
    return
  }

  const dynamicImports = Object.create(null)
  Promise.all(components.map(component => {
    return resolve.call(this, component.source).then(resolved => {
      component.name = getComponentName(hyphenate(component.name))
      const source = component.source
      component.source = normalizeNodeModules(removeExt(path.relative(process.env.UNI_INPUT_DIR,
        resolved)))
      // 非页面组件才需要 dynamic import
      if (!process.UNI_ENTRY[component.source]) {
        dynamicImports[source] = {
          identifier: component.value,
          chunkName: component.source,
          source: source
        }
      }
    })
  })).then(() => {
    const usingComponents = Object.create(null)
    components.forEach(({
      name,
      source
    }) => {
      usingComponents[name] = `/${source}`
    })

    const babelLoader = findBabelLoader(this.loaders)
    if (!babelLoader) {
      callback(new Error('babel-loader 查找失败'), content)
    } else {
      addDynamicImport(babelLoader, resourcePath, dynamicImports)
      // ----------------------(新增)
      updateUsingComponents(resourcePath, usingComponents, type, asyncCustomComponents)
      // ----------------------
      callback(null, content, map)
    }
  }, err => {
    callback(err, content, map)
  })
}
```
- 3、将asyncCustomComponents分包异步配置透传到updateJsonFile（小程序json文件配置设置）
```
node_modules/@dcloudio/uni-cli-shared/lib/cache.js

function updateUsingComponents (name, usingComponents, type, asyncCustomComponents) {
  if (type === 'Component') {
    componentSet.add(name)
  }
  if (type === 'App') { // 记录全局组件
    globalUsingComponents = usingComponents
  }
  const oldJsonStr = getJsonFile(name)
  if (oldJsonStr) { // update
    const jsonObj = JSON.parse(oldJsonStr)
    if (type === 'Component') {
      jsonObj.component = true
    } else if (type === 'Page') {
      if (process.env.UNI_PLATFORM === 'mp-baidu') {
        jsonObj.component = true
      }
    }

    jsonObj.usingComponents = usingComponents
    
    // ----------------------(新增)
    // 异步分包自定义组件注册其他分包的组件引入 
    if(asyncCustomComponents && asyncCustomComponents.length) {
      jsonObj.asyncCustomComponents = asyncCustomComponents
    }
    // ----------------------
    
    const newJsonStr = JSON.stringify(jsonObj, null, 2)
    if (newJsonStr !== oldJsonStr) {
      updateJsonFile(name, newJsonStr)
    }
  } else { // add
    const jsonObj = {
      usingComponents
    }
    if (type === 'Component') {
      jsonObj.component = true
    } else if (type === 'Page') {
      if (process.env.UNI_PLATFORM === 'mp-baidu') {
        jsonObj.component = true
      }
    }
    // ----------------------(新增)
    // 异步分包自定义组件注册其他分包的组件引入
    jsonObj.asyncCustomComponents = asyncCustomComponents
    // ----------------------
    updateJsonFile(name, jsonObj)
  }
}
```
- 4、通过asyncCustomComponents配置，设置json文件的componentPlaceholder（ 组件占位）以及usingComponents（组件引用配置）
```
node_modules/@dcloudio/webpack-uni-mp-loader/lib/plugin/generate-json.js

module.exports = function generateJson (compilation) {
  analyzeUsingComponents()

  const jsonFileMap = getChangedJsonFileMap()
  for (const name of jsonFileMap.keys()) {
    const jsonObj = JSON.parse(jsonFileMap.get(name))
    if (process.env.UNI_PLATFORM === 'app-plus') { // App平台默认增加usingComponents,激活__wxAppCode__
      jsonObj.usingComponents = jsonObj.usingComponents || {}
    }
    // customUsingComponents
    if (jsonObj.customUsingComponents && Object.keys(jsonObj.customUsingComponents).length) {
      jsonObj.usingComponents = Object.assign(jsonObj.customUsingComponents, jsonObj.usingComponents)
    }
    delete jsonObj.customUsingComponents
    // usingGlobalComponents
    if (jsonObj.usingGlobalComponents && Object.keys(jsonObj.usingGlobalComponents).length) {
      jsonObj.usingComponents = Object.assign(jsonObj.usingGlobalComponents, jsonObj.usingComponents)
    }
    delete jsonObj.usingGlobalComponents

    // usingAutoImportComponents
    if (jsonObj.usingAutoImportComponents && Object.keys(jsonObj.usingAutoImportComponents).length) {
      jsonObj.usingComponents = Object.assign(jsonObj.usingAutoImportComponents, jsonObj.usingComponents)
    }
    delete jsonObj.usingAutoImportComponents

    // ----------------------(新增)
    // 异步分包自定义组件注册其他分包的组件引入
    if (jsonObj.asyncCustomComponents && jsonObj.asyncCustomComponents.length) {
      const asyncCustomComponents = jsonObj.asyncCustomComponents.reduce((p, n) => {
        p[n.name] = n.value
        return p
      }, {})
      const componentPlaceholder = jsonObj.asyncCustomComponents.reduce((p, n) => {
        p[n.name] = 'view'
        return p
      }, {})
      jsonObj.componentPlaceholder = componentPlaceholder
      jsonObj.usingComponents = Object.assign(asyncCustomComponents, jsonObj.usingComponents)
    }
    delete jsonObj.asyncCustomComponents
    // ----------------------
    // 百度小程序插件内组件使用 usingSwanComponents
    if (process.env.UNI_PLATFORM === 'mp-baidu') {
      const usingComponents = jsonObj.usingComponents || {}
      Object.keys(usingComponents).forEach(key => {
        const value = usingComponents[key]
        if (value.includes('://')) {
          /**
           * 百度小程序部分组件（如：editor）使用‘usingSwanComponents’ 引入
           * 部分组件（如：swan-sitemap-list）使用'usingComponents'引入
           * 经测试，两者保留都不会报错，因此去除以下 delete 语句
           */
          // delete usingComponents[key]
          jsonObj.usingSwanComponents = jsonObj.usingSwanComponents || {}
          jsonObj.usingSwanComponents[key] = value
        }
      })
    }

    if (jsonObj.genericComponents && jsonObj.genericComponents.length) { // scoped slots
      // 生成genericComponents json
      const genericComponents = Object.create(null)

      const scopedSlotComponents = []
      jsonObj.genericComponents.forEach(genericComponentName => {
        const genericComponentFile = normalizePath(
          path.join(path.dirname(name), genericComponentName + '.json')
        )
        genericComponents[genericComponentName] = '/' +
          genericComponentFile.replace(
            path.extname(genericComponentFile), ''
          )
        scopedSlotComponents.push(genericComponentFile)
      })

      jsonObj.usingComponents = Object.assign(genericComponents, jsonObj.usingComponents)

      const scopedSlotComponentJson = {
        component: true,
        usingComponents: jsonObj.usingComponents,
      }

      const scopedSlotComponentJsonSource = JSON.stringify(scopedSlotComponentJson, null, 2)

      scopedSlotComponents.forEach(scopedSlotComponent => {
        compilation.assets[scopedSlotComponent] = {
          size () {
            return Buffer.byteLength(scopedSlotComponentJsonSource, 'utf8')
          },
          source () {
            return scopedSlotComponentJsonSource
          }
        }
      })
    }

    delete jsonObj.genericComponents

    if (process.env.UNI_PLATFORM !== 'app-plus' && process.env.UNI_PLATFORM !== 'h5') {
      delete jsonObj.navigationBarShadow
    }

    if ((process.env.UNI_SUBPACKGE || process.env.UNI_MP_PLUGIN) && jsonObj.usingComponents) {
      jsonObj.usingComponents = normalizeUsingComponents(name, jsonObj.usingComponents)
    }
    const source = JSON.stringify(jsonObj, null, 2)

    const jsFile = name.replace('.json', '.js')
    if (
      ![
        'app.js',
        'manifest.js',
        'mini.project.js',
        'quickapp.config.js',
        'project.config.js',
        'project.swan.js'
      ].includes(
        jsFile) &&
      !compilation.assets[jsFile]
    ) {
      const jsFileAsset = {
        size () {
          return Buffer.byteLength(EMPTY_COMPONENT, 'utf8')
        },
        source () {
          return EMPTY_COMPONENT
        }
      }
      compilation.assets[jsFile] = jsFileAsset
    }
    const jsonAsset = {
      size () {
        return Buffer.byteLength(source, 'utf8')
      },
      source () {
        return source
      }
    }

    compilation.assets[name] = jsonAsset
  }
  if (process.env.UNI_USING_CACHE && jsonFileMap.size) {
    setTimeout(() => {
      require('@dcloudio/uni-cli-shared/lib/cache').store()
    }, 50)
  }
}
```
- 5、asyncCustomComponents配置babel解析结束。

#### 3.1.2 asyncCustomComponents组件注册编译（处理asyncCustomComponents中注册的未被引用过组件的编译打包问题）
- 1、content解析，处理asyncCustomComponents转换成import引入，并注册components
```
【新增】node_modules/@dcloudio/webpack-uni-mp-loader/lib/babel/scoped-async-component-traverse.js

const t = require('@babel/types')
const babelTraverse = require('@babel/traverse').default
const parser = require('@babel/parser')
const {
  getBabelParserOptions
} = require('@dcloudio/uni-cli-shared/lib/platform')

const {
  getCode
} = require('@dcloudio/uni-template-compiler/lib/util')

function handleObjectExpression(contentObj, path, state, ast) {
  console.log('[getCode-path]', );
  // console.log('[getCode-ast]', ast);
  // console.log('[getCode-code-ast]', getCode(ast));
  const properties = path.container.value.properties
  let list = ''
  const componentNodes = []
  properties.forEach(_ => {
    const name = _.key.value.replace(/\-(\w)/g, function(all, letter){
      return letter.toUpperCase();
    })
    const value = _.value.value
    const asyncCustomComponentsToImport = `import ${name} from '${'@' + value}';`
    list += asyncCustomComponentsToImport
    console.log('[name]', name);
    const node = parser.parseExpression(name, getBabelParserOptions())
    componentNodes.push(node)
  })
  const nodes = parser.parse(list, getBabelParserOptions()).program.body
  const idx = ast.program.body.findIndex(_ => _.type === 'ExportDefaultDeclaration')
  const ExportDefaultDeclarationNode = ast.program.body[idx]
  ast.program.body.splice(idx, 0, ...nodes)

  const componentIdx = ExportDefaultDeclarationNode.declaration.properties.findIndex(_ => _.key.name === 'components')
  const componentNode = ExportDefaultDeclarationNode.declaration.properties[componentIdx]
  componentNode.value.properties.splice(componentIdx, 0, ...componentNodes)

  const content = getCode(ast)
  contentObj.content = content
}

module.exports = function (content, state = {
  type: 'Component',
  components: [],
  options: {}
}) {
  const contentObj = {}
  // console.log('[getCode-objExpr]', content);
  const ast = parser.parse(content, getBabelParserOptions())
  // console.log('[getCode-objExpr-ast]', getCode(ast));
  babelTraverse(ast, {
    enter(path) {
      if (path.isIdentifier({ name: 'asyncCustomComponents' })) {
        handleObjectExpression(contentObj, path, state, ast)
      }
    },
  });
  // console.log('[content]', contentObj.content);
  return {
    content: contentObj.content,
    state
  }
}
```
- 2、content替换
```
node_modules/@dcloudio/webpack-uni-mp-loader/lib/script-new.js

module.exports = function (content, map) {
  this.cacheable && this.cacheable()

  content = preprocessor.preprocess(content, jsPreprocessOptions.context, {
    type: jsPreprocessOptions.type
  })

  let resourcePath = normalizeNodeModules(removeExt(normalizePath(path.relative(process.env.UNI_INPUT_DIR, this
    .resourcePath))))

  let type = ''
  if (resourcePath === 'App') {
    type = 'App'
  } else if (process.UNI_ENTRY[resourcePath]) {
    type = 'Page'
  }
  // <script src=""/>
  if (!type && this._module.issuer && this._module.issuer.issuer) {
    resourcePath = normalizeNodeModules(removeExt(normalizePath(path.relative(process.env.UNI_INPUT_DIR, this._module
      .issuer.issuer.resource))))
    if (resourcePath === 'App') {
      type = 'App'
    } else if (process.UNI_ENTRY[resourcePath]) {
      type = 'Page'
    }
  }

  if ( // windows 上 page-meta, navigation-bar 可能在不同盘上
    /^win/.test(process.platform) &&
    path.isAbsolute(resourcePath) &&
    isBuiltInComponentPath(resourcePath)
  ) {
    resourcePath = normalizePath(path.relative(process.env.UNI_CLI_CONTEXT, resourcePath))
  }

  if (!type) {
    type = 'Component'
  }
  // ----------------------(新增)
  // asyncCustomComponents 配置的content替换
  if(content.includes('asyncCustomComponents')) {
    const asyncTraverseObj = asyncTraverse(content, {
      type,
      components: []
    })
    content = asyncTraverseObj.content ? asyncTraverseObj.content : content
  }
  // ----------------------
  const {
    state: {
      components,
      asyncCustomComponents,
    }
  } = traverse(parser.parse(content, getBabelParserOptions()), {
    type,
    components: []
  })

  const callback = this.async()

  if (!components.length) {
    if (type === 'App') {
      callback(null, content, map)
      return
    }
    // 防止组件从有到无，App.vue 中不支持使用组件
    updateUsingComponents(resourcePath, Object.create(null), type)
    callback(null, content, map)
    return
  }

  const dynamicImports = Object.create(null)
  Promise.all(components.map(component => {
    return resolve.call(this, component.source).then(resolved => {
      component.name = getComponentName(hyphenate(component.name))
      const source = component.source
      component.source = normalizeNodeModules(removeExt(path.relative(process.env.UNI_INPUT_DIR,
        resolved)))
      // 非页面组件才需要 dynamic import
      if (!process.UNI_ENTRY[component.source]) {
        dynamicImports[source] = {
          identifier: component.value,
          chunkName: component.source,
          source: source
        }
      }
    })
  })).then(() => {
    const usingComponents = Object.create(null)
    components.forEach(({
      name,
      source
    }) => {
      usingComponents[name] = `/${source}`
    })

    const babelLoader = findBabelLoader(this.loaders)
    if (!babelLoader) {
      callback(new Error('babel-loader 查找失败'), content)
    } else {
      addDynamicImport(babelLoader, resourcePath, dynamicImports)
      updateUsingComponents(resourcePath, usingComponents, type, asyncCustomComponents)
      callback(null, content, map)
    }
  }, err => {
    callback(err, content, map)
  })
}
```
- 3、未被引用过的组件编译打包完成

### 3.2 生成patches补丁包
> 通过patch-package给@dcloudio打补丁包

教程：[手把手教你使用patch-package给npm包打补丁 - 掘金](https://juejin.cn/post/6962554654643191815)

#### 1、项目根目录生成patches
```
@dcloudio+uni-cli-shared+2.0.0-31920210514002.patch

diff --git a/node_modules/@dcloudio/uni-cli-shared/lib/cache.js b/node_modules/@dcloudio/uni-cli-shared/lib/cache.js
index ef8e296..dd3b7c3 100644
--- a/node_modules/@dcloudio/uni-cli-shared/lib/cache.js
+++ b/node_modules/@dcloudio/uni-cli-shared/lib/cache.js
@@ -136,7 +136,7 @@ function updateUsingAutoImportComponents (name, usingAutoImportComponents) {
   }
 }
 
-function updateUsingComponents (name, usingComponents, type) {
+function updateUsingComponents (name, usingComponents, type, asyncCustomComponents) {
   if (type === 'Component') {
     componentSet.add(name)
   }
@@ -154,7 +154,12 @@ function updateUsingComponents (name, usingComponents, type) {
         jsonObj.component = true
       }
     }
-
+    // ----------------------(新增)
+    // 异步分包自定义组件注册其他分包的组件引入 
+    if(asyncCustomComponents && asyncCustomComponents.length) {
+      jsonObj.asyncCustomComponents = asyncCustomComponents
+    }
+    // ----------------------
     jsonObj.usingComponents = usingComponents
     const newJsonStr = JSON.stringify(jsonObj, null, 2)
     if (newJsonStr !== oldJsonStr) {
@@ -171,7 +176,12 @@ function updateUsingComponents (name, usingComponents, type) {
         jsonObj.component = true
       }
     }
-
+    // ----------------------(新增)
+    // 异步分包自定义组件注册其他分包的组件引入
+    if(asyncCustomComponents && asyncCustomComponents.length) {
+      jsonObj.asyncCustomComponents = asyncCustomComponents
+    }
+    // ----------------------
     updateJsonFile(name, jsonObj)
   }
 }
```
```
@dcloudio+webpack-uni-mp-loader+2.0.0-31920210514002.patch

diff --git a/node_modules/@dcloudio/webpack-uni-mp-loader/lib/babel/scoped-async-component-traverse.js b/node_modules/@dcloudio/webpack-uni-mp-loader/lib/babel/scoped-async-component-traverse.js
new file mode 100644
index 0000000..52d0c44
--- /dev/null
+++ b/node_modules/@dcloudio/webpack-uni-mp-loader/lib/babel/scoped-async-component-traverse.js
@@ -0,0 +1,57 @@
+const t = require('@babel/types')
+const babelTraverse = require('@babel/traverse').default
+const parser = require('@babel/parser')
+const {
+  getBabelParserOptions
+} = require('@dcloudio/uni-cli-shared/lib/platform')
+
+const {
+  getCode
+} = require('@dcloudio/uni-template-compiler/lib/util')
+
+function handleObjectExpression(contentObj, path, state, ast) {
+  const properties = path.container.value.properties
+  let list = ''
+  const componentNodes = []
+  properties.forEach(_ => {
+    const name = _.key.value.replace(/\-(\w)/g, function(all, letter){
+      return letter.toUpperCase();
+    })
+    const value = _.value.value
+    const asyncCustomComponentsToImport = `import ${name} from '${'@' + value}';`
+    list += asyncCustomComponentsToImport
+    const node = parser.parseExpression(name, getBabelParserOptions())
+    componentNodes.push(node)
+  })
+  const nodes = parser.parse(list, getBabelParserOptions()).program.body
+  const idx = ast.program.body.findIndex(_ => _.type === 'ExportDefaultDeclaration')
+  const ExportDefaultDeclarationNode = ast.program.body[idx]
+  ast.program.body.splice(idx, 0, ...nodes)
+
+  const componentIdx = ExportDefaultDeclarationNode.declaration.properties.findIndex(_ => _.key.name === 'components')
+  const componentNode = ExportDefaultDeclarationNode.declaration.properties[componentIdx]
+  componentNode.value.properties.splice(componentIdx, 0, ...componentNodes)
+
+  const content = getCode(ast)
+  contentObj.content = content
+}
+
+module.exports = function (content, state = {
+  type: 'Component',
+  components: [],
+  options: {}
+}) {
+  const contentObj = {}
+  const ast = parser.parse(content, getBabelParserOptions())
+  babelTraverse(ast, {
+    enter(path) {
+      if (path.isIdentifier({ name: 'asyncCustomComponents' })) {
+        handleObjectExpression(contentObj, path, state, ast)
+      }
+    },
+  });
+  return {
+    content: contentObj.content,
+    state
+  }
+}
\ No newline at end of file
diff --git a/node_modules/@dcloudio/webpack-uni-mp-loader/lib/babel/scoped-component-traverse.js b/node_modules/@dcloudio/webpack-uni-mp-loader/lib/babel/scoped-component-traverse.js
index cc2fcc4..5957d7a 100644
--- a/node_modules/@dcloudio/webpack-uni-mp-loader/lib/babel/scoped-component-traverse.js
+++ b/node_modules/@dcloudio/webpack-uni-mp-loader/lib/babel/scoped-component-traverse.js
@@ -47,11 +47,32 @@ function handleObjectExpression (declaration, path, state) {
       t.isIdentifier(prop.key) &&
       prop.key.name === 'components'
   })[0]
-
+  // ----------------------(新增)
+  const asyncCustomComponentsProperty = declaration.properties.filter(prop => {
+    return t.isObjectProperty(prop) &&
+      t.isIdentifier(prop.key) &&
+      prop.key.name === 'asyncCustomComponents'
+  })[0]
+  if(asyncCustomComponentsProperty) {
+    handleAsyncCustomComponentsObjectExpression(asyncCustomComponentsProperty.value, path, state)
+  }
+  // ----------------------
   if (componentsProperty && t.isObjectExpression(componentsProperty.value)) {
     handleComponentsObjectExpression(componentsProperty.value, path, state)
   }
 }
+// ----------------------(新增)
+function handleAsyncCustomComponentsObjectExpression(componentsObjExpr, path, state) {
+  const properties = componentsObjExpr.properties
+  const asyncCustomComponentsDeclaration = properties.map(prop => {
+    return {
+      name: prop.key.name || prop.key.value,
+      value: prop.value.value
+    }
+  })
+  state.asyncCustomComponents = asyncCustomComponentsDeclaration
+}
+// ----------------------
 
 function handleComponentsObjectExpression (componentsObjExpr, path, state, prepend) {
   const properties = componentsObjExpr.properties
diff --git a/node_modules/@dcloudio/webpack-uni-mp-loader/lib/plugin/generate-json.js b/node_modules/@dcloudio/webpack-uni-mp-loader/lib/plugin/generate-json.js
index ab8fe09..7c3d72c 100644
--- a/node_modules/@dcloudio/webpack-uni-mp-loader/lib/plugin/generate-json.js
+++ b/node_modules/@dcloudio/webpack-uni-mp-loader/lib/plugin/generate-json.js
@@ -1,7 +1,9 @@
 const path = require('path')
 
 const {
-  normalizePath
+  normalizePath,
+  hyphenate,
+  getComponentName
 } = require('@dcloudio/uni-cli-shared')
 
 const {
@@ -122,7 +124,22 @@ module.exports = function generateJson (compilation) {
       jsonObj.usingComponents = Object.assign(jsonObj.usingAutoImportComponents, jsonObj.usingComponents)
     }
     delete jsonObj.usingAutoImportComponents
-
+    // ----------------------(新增)
+    // 异步分包自定义组件注册其他分包的组件引入
+    if (jsonObj.asyncCustomComponents && jsonObj.asyncCustomComponents.length) {
+      const asyncCustomComponents = jsonObj.asyncCustomComponents.reduce((p, n) => {
+        p[getComponentName(hyphenate(n.name))] = n.value
+        return p
+      }, {})
+      const componentPlaceholder = jsonObj.asyncCustomComponents.reduce((p, n) => {
+        p[getComponentName(hyphenate(n.name))] = 'view'
+        return p
+      }, {})
+      jsonObj.componentPlaceholder = componentPlaceholder
+      jsonObj.usingComponents = Object.assign(asyncCustomComponents, jsonObj.usingComponents)
+    }
+    delete jsonObj.asyncCustomComponents
+    // ----------------------
     // 百度小程序插件内组件使用 usingSwanComponents
     if (process.env.UNI_PLATFORM === 'mp-baidu') {
       const usingComponents = jsonObj.usingComponents || {}
diff --git a/node_modules/@dcloudio/webpack-uni-mp-loader/lib/script-new.js b/node_modules/@dcloudio/webpack-uni-mp-loader/lib/script-new.js
index 335552e..6b79605 100644
--- a/node_modules/@dcloudio/webpack-uni-mp-loader/lib/script-new.js
+++ b/node_modules/@dcloudio/webpack-uni-mp-loader/lib/script-new.js
@@ -25,6 +25,7 @@ const {
 const preprocessor = require('@dcloudio/vue-cli-plugin-uni/packages/webpack-preprocess-loader/preprocess')
 
 const traverse = require('./babel/scoped-component-traverse')
+const asyncTraverse = require('./babel/scoped-async-component-traverse')
 
 const {
   resolve,
@@ -74,10 +75,22 @@ module.exports = function (content, map) {
   if (!type) {
     type = 'Component'
   }
-
+  // ----------------------(新增)
+  // asyncCustomComponents 配置的content替换
+  if(content.includes('asyncCustomComponents')) {
+    const asyncTraverseObj = asyncTraverse(content, {
+      type,
+      components: []
+    })
+    content = asyncTraverseObj.content ? asyncTraverseObj.content : content
+  }
+  // ----------------------
   const {
     state: {
-      components
+      components,
+      // ----------------------(新增)
+      asyncCustomComponents,
+      // ----------------------
     }
   } = traverse(parser.parse(content, getBabelParserOptions()), {
     type,
@@ -92,7 +105,9 @@ module.exports = function (content, map) {
       return
     }
     // 防止组件从有到无，App.vue 中不支持使用组件
-    updateUsingComponents(resourcePath, Object.create(null), type)
+    // ----------------------(新增)
+    updateUsingComponents(resourcePath, Object.create(null), type, asyncCustomComponents)
+    // ----------------------
     callback(null, content, map)
     return
   }
@@ -127,8 +142,9 @@ module.exports = function (content, map) {
       callback(new Error('babel-loader 查找失败'), content)
     } else {
       addDynamicImport(babelLoader, resourcePath, dynamicImports)
-
-      updateUsingComponents(resourcePath, usingComponents, type)
+      // ----------------------(新增)
+      updateUsingComponents(resourcePath, usingComponents, type, asyncCustomComponents)
+      // ----------------------
       callback(null, content, map)
     }
   }, err => {
```
#### 2、项目根目录创建script/patch-package-init.js
```
const execSync = require('child_process').execSync;
const { INIT_CWD, PWD } = process.env;

if (!INIT_CWD || INIT_CWD === PWD || INIT_CWD.toString().replace(/\\/g, () => '/').indexOf(PWD) === 0) {
  const command = ['npx', ...process.argv.slice(2, process.argv.length)].join(' ');
  execSync(command, { stdio: 'inherit' });
}

process.exit(0);
```
#### 3、merge 补丁
```
"scripts": {
    "postinstall": "node ./scripts/patch-package-init.js patch-package"
}
```

## 4、项目中使用
#### 4、1 项目添加patch-package依赖
```
npm install --save-dev patch-package
```
#### 4、2 拷贝scripts脚本和patches到项目根目录
- ./scripts
- ./patches
#### 4、3 配置postinstall自动执行patch
```
{
  "scripts": {
      "postinstall": "node ./scripts/patch-package-init.js patch-package"
  }
}
```
#### 4、4 执行同步patch
```
npm run postinstall
```


