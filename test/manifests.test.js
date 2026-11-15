/**
 * manifests.test.js —— 依赖清单解析（node --test）
 * ---------------------------------------------------------------------------
 * pom.xml 用正则解析（为了守住「零第三方依赖」的承诺），所以边界必须锁死：
 *   · parent 段里的 groupId/version 不能被当成 project 自己的
 *   · dependencyManagement 里的依赖不能混进「直接依赖」
 *   · 子模块 <module> 列表要单独拿出
 *   · 版本没写就是 null，不许瞎填
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parsePom, parseGradle, parsePackageJson, collectManifests } from '../lib/manifests.js'

/* ------------------------------------------------------------------ Maven */

const ROOT_POM = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.demo</groupId>
  <artifactId>demo-parent</artifactId>
  <version>2.0.0</version>
  <packaging>pom</packaging>
  <modules>
    <module>core</module>
    <module>web</module>
  </modules>
  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-dependencies</artifactId>
        <version>3.2.0</version>
        <type>pom</type>
        <scope>import</scope>
      </dependency>
    </dependencies>
  </dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>org.slf4j</groupId>
      <artifactId>slf4j-api</artifactId>
      <version>2.0.9</version>
    </dependency>
  </dependencies>
</project>`

const CHILD_POM = `<project>
  <parent>
    <groupId>com.demo</groupId>
    <artifactId>demo-parent</artifactId>
    <version>2.0.0</version>
  </parent>
  <artifactId>demo-core</artifactId>
  <dependencies>
    <dependency>
      <groupId>com.demo</groupId>
      <artifactId>demo-common</artifactId>
      <version>\${project.version}</version>
      <scope>test</scope>
    </dependency>
    <dependency>
      <groupId>com.google.guava</groupId>
      <artifactId>guava</artifactId>
      <optional>true</optional>
    </dependency>
  </dependencies>
</project>`

test('parsePom: 读根工程的坐标、packaging 与子模块', () => {
  const pom = parsePom(ROOT_POM)
  assert.equal(pom.groupId, 'com.demo')
  assert.equal(pom.artifactId, 'demo-parent')
  assert.equal(pom.version, '2.0.0')
  assert.equal(pom.packaging, 'pom')
  assert.deepEqual(pom.modules, ['core', 'web'])
})

test('parsePom: dependencyManagement 不混进直接依赖', () => {
  const pom = parsePom(ROOT_POM)
  assert.equal(pom.deps.length, 1, '直接依赖只该有 slf4j 一条')
  assert.equal(pom.deps[0].artifactId, 'slf4j-api')
  assert.equal(pom.managed.length, 1, 'dependencyManagement 该单独收集')
  assert.equal(pom.managed[0].artifactId, 'spring-boot-dependencies')
})

test('parsePom: parent 的 groupId/version 不能被当成 project 自己的（子模块场景）', () => {
  const pom = parsePom(CHILD_POM)
  // 子模块自己没写 groupId/version，按 Maven 语义应继承 parent
  assert.equal(pom.groupId, 'com.demo', 'groupId 应继承自 parent')
  assert.equal(pom.version, '2.0.0', 'version 应继承自 parent')
  assert.equal(pom.artifactId, 'demo-core', 'artifactId 必须是自己的，不能取 parent 的')
  assert.equal(pom.parent.artifactId, 'demo-parent')
})

test('parsePom: 没写 version 的依赖如实返回 null，不瞎填', () => {
  const pom = parsePom(CHILD_POM)
  const guava = pom.deps.find((d) => d.artifactId === 'guava')
  assert.ok(guava, 'guava 应在直接依赖里')
  assert.equal(guava.version, null, '没写版本就该是 null')
  assert.equal(guava.optional, true)
})

test('parsePom: scope 默认 compile，显式 scope 保留', () => {
  const pom = parsePom(CHILD_POM)
  const commons = pom.deps.find((d) => d.artifactId === 'demo-common')
  assert.equal(commons.scope, 'test')
  const guava = pom.deps.find((d) => d.artifactId === 'guava')
  assert.equal(guava.scope, 'compile')
})

test('parsePom: 不是 pom 的文本返回 null', () => {
  assert.equal(parsePom('hello world'), null)
  assert.equal(parsePom('<html></html>'), null)
  assert.equal(parsePom(null), null)
})

/* ------------------------------------------------------------------ Gradle */

test('parseGradle: 认坐标式依赖与 configuration', () => {
  const gradle = parseGradle(`
plugins { id 'java' }
dependencies {
  implementation "org.springframework.boot:spring-boot-starter-web:3.2.0"
  testImplementation 'junit:junit:4.13.2'
  compileOnly("org.projectlombok:lombok:1.18.30")
}
`)
  assert.ok(gradle)
  const web = gradle.deps.find((d) => d.artifactId === 'spring-boot-starter-web')
  assert.equal(web.groupId, 'org.springframework.boot')
  assert.equal(web.version, '3.2.0')
  assert.equal(web.configuration, 'implementation')
  assert.ok(gradle.deps.some((d) => d.configuration === 'testImplementation'))
  assert.ok(gradle.deps.some((d) => d.configuration === 'compileOnly'))
})

test('parseGradle: 变量拼接的坐标丢弃并记进 skipped，不生成看着像真的假依赖', () => {
  const gradle = parseGradle(`
dependencies {
  implementation "com.demo:${'${'}libName${'}'}:${'${'}libVersion${'}'}"
  implementation "org.real:real-lib:1.0.0"
}
`)
  assert.ok(gradle, '整体不该返回 null')
  assert.equal(gradle.deps.length, 1, '只保留 x 不含变量的那条')
  assert.equal(gradle.deps[0].artifactId, 'real-lib')
  assert.equal(gradle.skipped.length, 1, '变量拼接的应记进 skipped')
  assert.match(gradle.skipped[0].raw, /libName/, 'skipped 里保留原始写法便于排查')
})

/* ------------------------------------------------------------------ Node */

test('parsePackageJson: 四类依赖都收，scripts 单独拿', () => {
  const pkg = parsePackageJson(JSON.stringify({
    name: 'demo',
    version: '1.0.0',
    dependencies: { react: '^18.0.0' },
    devDependencies: { typescript: '^5.0.0' },
    peerDependencies: { cordis: '>=4' },
    optionalDependencies: { fsevents: '*' },
    scripts: { build: 'tsc' },
  }))
  assert.equal(pkg.name, 'demo')
  assert.equal(pkg.deps.length, 4)
  assert.deepEqual(Object.keys(pkg.scripts), ['build'])
})

test('parsePackageJson: 坏 JSON 返回 null 而不是抛', () => {
  assert.equal(parsePackageJson('{not json'), null)
})

/* ------------------------------------------------------------------ 汇总 */

function fakeReader(map) {
  return (rel) => (rel in map ? map[rel] : null)
}

test('collectManifests: 多模块工程把每个 pom 都收进来，模块名用目录相对路径', () => {
  const files = {
    'pom.xml': ROOT_POM,
    'core/pom.xml': CHILD_POM,
    'package.json': JSON.stringify({ name: 'ui', dependencies: { vue: '^3' } }),
    'build.gradle': 'dependencies { implementation "a:b:1" }',
  }
  const result = collectManifests(fakeReader(files), Object.keys(files))
  assert.equal(result.maven.length, 2)
  assert.equal(result.node.length, 1)
  assert.equal(result.gradle.length, 1)
  assert.deepEqual(result.maven.map((m) => m.module).sort(), ['(根)', 'core'])
})

test('collectManifests: 跳过 target/ 与 node_modules/ 里的清单', () => {
  const files = {
    'pom.xml': ROOT_POM,
    'target/classes/pom.xml': ROOT_POM,
    'node_modules/x/package.json': JSON.stringify({ dependencies: { a: '1' } }),
  }
  const result = collectManifests(fakeReader(files), Object.keys(files))
  assert.equal(result.maven.length, 1, 'target 里的 pom 不该被算')
  assert.equal(result.node.length, 0, 'node_modules 里的 package.json 不该被算')
})

test('collectManifests: 坏清单在 notes 里如实说明，不静默丢', () => {
  const files = {
    'broken/package.json': '{not json',
    'weird/pom.xml': '<not-a-project/>',
  }
  const result = collectManifests(fakeReader(files), Object.keys(files))
  assert.ok(result.notes.some((n) => n.includes('不是合法 JSON')), '坏 package.json 应进 notes')
  assert.ok(result.notes.some((n) => n.includes('不是标准 Maven pom')), '坏 pom 应进 notes')
})

test('collectManifests: 有 Maven 时附上解析边界说明', () => {
  const files = { 'pom.xml': ROOT_POM }
  const result = collectManifests(fakeReader(files), ['pom.xml'])
  assert.ok(result.notes.some((n) => n.includes('parent') && n.includes('BOM')), '应说明 Maven 的解析边界')
})

test('collectManifests: 完全没有清单时三个数组都是空，notes 为空', () => {
  const result = collectManifests(fakeReader({}), ['src/a.ts'])
  assert.deepEqual(result.maven, [])
  assert.deepEqual(result.gradle, [])
  assert.deepEqual(result.node, [])
  assert.equal(result.manifests.length, 0)
})
