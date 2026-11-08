
import Konva from "konva";
import "./style.css";

import JSZip from "jszip";

import {
  saveProject,
  loadProject,
  saveImage,
  loadImageBlob,
  deleteImage,
} from "./storage.js";


const W = 1024;
const H = 1536;

const CATEGORIES = {
  hair: 50,
  tops: 30,
  skirts: 20,
  shoes: 10,
  accessories: 60,
};

const $ = (id) => document.getElementById(id);
const round = (n) => Math.round(n * 1000) / 1000;

// 素材库与当前装备
const assets = [];
const equipped = {};

let selectedId = null;
let nextId = 2;


let restoring = false;
let saveTimer = null;
let saveQueue = Promise.resolve();

function projectSnapshot() {
  return {
    version: 3,
    canvas: { width: W, height: H },
    character: "/assets/character_base.png",
    selectedId,
    nextId,
    assets: assets.map(serialize),
  };
}

function requestSave() {
  if (restoring) return;

  clearTimeout(saveTimer);

  $("save-status").textContent = "有未保存的更改...";

  saveTimer = setTimeout(() => {
    const snapshot = projectSnapshot();

    saveQueue = saveQueue
      .catch(() => {})
      .then(() => saveProject(snapshot));

    saveQueue.then(() => {
      $("save-status").textContent = "已自动保存";
    }).catch((error) => {
      console.error(error);
      $("save-status").textContent = "保存失败，请导出 ZIP 备份";
    });
  }, 500);
}


const stage = new Konva.Stage({
  container: "stage-container",
  width: W,
  height: H,
});

const bodyLayer = new Konva.Layer();
const clothingLayer = new Konva.Layer();
const controlLayer = new Konva.Layer();

stage.add(bodyLayer);
stage.add(clothingLayer);
stage.add(controlLayer);

const transformer = new Konva.Transformer({
  rotateEnabled: true,
  flipEnabled: false,
  keepRatio: false,
  anchorSize: 9,
  borderStroke: "#d783af",
  anchorStroke: "#d783af",
  anchorFill: "#ffffff",
  boundBoxFunc: (oldBox, newBox) => {
    if (
      Math.abs(newBox.width) < 10 ||
      Math.abs(newBox.height) < 10
    ) {
      return oldBox;
    }
    return newBox;
  },
});

controlLayer.add(transformer);

// 加载图片
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(
      new Error("图片加载失败：" + src)
    );
    image.src = src;
  });
}

// 找到图片非透明像素的最小外接矩形
function findAlphaBounds(image) {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;

  const ctx = canvas.getContext("2d", {
    willReadFrequently: true,
  });
  ctx.drawImage(image, 0, 0);

  const { data } = ctx.getImageData(
    0, 0, image.width, image.height
  );

  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;

  // 忽略几乎完全透明的边缘噪声
  const threshold = 5;

  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const alpha = data[
        (y * image.width + x) * 4 + 3
      ];

      if (alpha > threshold) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  if (maxX < 0) {
    throw new Error("图片中没有可见像素");
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

// 将实际服饰区域裁剪到单独的 Canvas
function cropImage(image, bounds) {
  const canvas = document.createElement("canvas");
  canvas.width = bounds.width;
  canvas.height = bounds.height;

  canvas.getContext("2d").drawImage(
    image,
    bounds.x,
    bounds.y,
    bounds.width,
    bounds.height,
    0,
    0,
    bounds.width,
    bounds.height
  );

  return canvas;
}

function getAsset(id) {
  return assets.find((asset) => asset.id === id);
}

function currentAsset() {
  return getAsset(selectedId);
}

function isVisible(asset) {
  return equipped[asset.category] === asset.id &&
         asset.enabled;
}

// 依据图层顺序排列服饰
function sortLayers() {
  const sorted = [...assets].sort((a, b) =>
    a.order - b.order ||
    a.id.localeCompare(b.id)
  );

  for (const asset of sorted) {
    asset.node.moveToTop();
  }

  clothingLayer.batchDraw();
}

// 更新衣服的显隐
function refreshVisibility() {
  for (const asset of assets) {
    asset.node.visible(isVisible(asset));
  }

  const selected = currentAsset();
  transformer.nodes(
    selected && isVisible(selected)
      ? [selected.node]
      : []
  );

  sortLayers();
  controlLayer.batchDraw();
}

// 获取可保存的服饰数据
function serialize(asset) {
  return {
    id: asset.id,
    name: asset.name,
    category: asset.category,
    image: asset.path,
    enabled: asset.enabled,
    equipped: equipped[asset.category] === asset.id,

    // 原图裁剪区域，用于恢复透明画布坐标
    crop: { ...asset.bounds },

    // 裁剪后服饰图层的位置及变换
    x: round(asset.node.x()),
    y: round(asset.node.y()),
    width: asset.bounds.width,
    height: asset.bounds.height,
    scaleX: round(asset.node.scaleX()),
    scaleY: round(asset.node.scaleY()),
    rotation: round(asset.node.rotation()),
    order: asset.order,
  };
}

// 添加素材
async function addAsset({
  id,
  name,
  category,
  src,
  path,
  config = null,
}) {
  if (!CATEGORIES.hasOwnProperty(category)) {
    throw new Error("未知服饰分类：" + category);
  }

  if (getAsset(id)) {
    throw new Error("素材 ID 已存在：" + id);
  }

  const image = await loadImage(src);

  const bounds = findAlphaBounds(image);
  const cropped = cropImage(image, bounds);

  // 完整画布素材按原有坐标摆放
  // 紧凑裁剪素材默认放到画布中央
  const isFullCanvas = image.width === W &&
                       image.height === H;

  const x = isFullCanvas
    ? bounds.x
    : (W - bounds.width) / 2;

  const y = isFullCanvas
    ? bounds.y
    : (H - bounds.height) / 2;

  const node = new Konva.Image({
    image: cropped,
    x,
    y,
    width: bounds.width,
    height: bounds.height,
    draggable: true,
  });

  if (config) {
    // 恢复导出配置
    node.position({
      x: config.x,
      y: config.y,
    });
    node.scale({
      x: config.scaleX,
      y: config.scaleY,
    });
    node.rotation(config.rotation);
  }

  const asset = {
    id,
    name,
    category,
    path,
    bounds,
    node,
    enabled: config?.enabled ?? true,
    order: config?.order ?? CATEGORIES[category],
  };

  assets.push(asset);
  clothingLayer.add(node);

  node.on("click tap", () => selectAsset(asset.id));

  node.on(
    "dragmove dragend transform transformend",
    updateProperties
  );

  if (config?.equipped || !equipped[category]) {
    equipped[category] = id;
  }

  selectAsset(id);
  renderAssetList();
  refreshVisibility();
}

// 在素材列表中选择某一件
function selectAsset(id) {
  const asset = getAsset(id);
  if (!asset) return;

  selectedId = id;
  $("category").value = asset.category;

  // 选择该素材时，将其穿到人物身上
  equipped[asset.category] = id;
  asset.enabled = true;

  refreshVisibility();
  renderAssetList();
  updateProperties();
}

// 关闭或打开某一件衣服
function toggleAsset(id) {
  const asset = getAsset(id);
  if (!asset) return;

  if (equipped[asset.category] !== id) {
    equipped[asset.category] = id;
    asset.enabled = true;
  } else {
    asset.enabled = !asset.enabled;
  }

  refreshVisibility();
  renderAssetList();
  updateProperties();
}

// 删除素材
function deleteAsset(id) {
  const asset = getAsset(id);
  if (!asset) return;

  asset.node.destroy();

  assets.splice(assets.indexOf(asset), 1);

  if (equipped[asset.category] === id) {
    delete equipped[asset.category];
  }

  if (selectedId === id) {
    selectedId = null;
  }

  refreshVisibility();
  renderAssetList();
  updateProperties();
}

// 左侧素材列表
function renderAssetList() {
  const category = $("category").value;
  const list = $("asset-list");
  list.replaceChildren();

  const filtered = assets.filter(
    (asset) => asset.category === category
  );

  if (!filtered.length) {
    list.textContent = "暂无素材，请导入 PNG";
    return;
  }

  for (const asset of filtered) {
    const item = document.createElement("div");
    item.className =
      "asset-item" +
      (asset.id === selectedId ? " active" : "");

    const name = document.createElement("button");
    name.className = "asset-name";
    name.textContent = asset.name;
    name.onclick = () => selectAsset(asset.id);

    const actions = document.createElement("div");
    actions.className = "asset-actions";

    const toggle = document.createElement("button");
    toggle.textContent = isVisible(asset)
      ? "隐藏"
      : "显示";
    toggle.onclick = () => toggleAsset(asset.id);

    const remove = document.createElement("button");
    remove.className = "danger";
    remove.textContent = "删除";
    remove.onclick = () => deleteAsset(asset.id);

    actions.append(toggle, remove);
    item.append(name, actions);
    list.append(item);
  }
}

// 更新右侧属性面板
function updateProperties() {
  const asset = currentAsset();
  const ids = [
    "pos-x", "pos-y", "scale-x",
    "scale-y", "rotation", "layer-order",
    "visible",
  ];

  if (!asset) {
    $("selection-name").textContent = "未选择素材";
    $("properties").textContent = "";

    for (const id of ids) {
      $(id).disabled = true;
    }
    return;
  }

  for (const id of ids) {
    $(id).disabled = false;
  }

  const config = serialize(asset);

  $("selection-name").textContent =
    `${asset.name} (${asset.id})`;

  $("visible").checked = isVisible(asset);
  $("pos-x").value = round(asset.node.x());
  $("pos-y").value = round(asset.node.y());
  $("scale-x").value = round(asset.node.scaleX());
  $("scale-y").value = round(asset.node.scaleY());
  $("rotation").value = round(asset.node.rotation());
  $("layer-order").value = asset.order;

  $("properties").textContent =
    JSON.stringify(config, null, 2);
}

// 将右侧输入应用到图层
function applyProperties() {
  const asset = currentAsset();
  if (!asset) return;

  const read = (id, fallback) => {
    const value = Number($(id).value);
    return $(id).value !== "" && Number.isFinite(value)
      ? value
      : fallback;
  };

  asset.node.position({
    x: read("pos-x", asset.node.x()),
    y: read("pos-y", asset.node.y()),
  });

  asset.node.scale({
    x: Math.max(0.01, read("scale-x", 1)),
    y: Math.max(0.01, read("scale-y", 1)),
  });

  asset.node.rotation(
    read("rotation", asset.node.rotation())
  );

  asset.order = read("layer-order", asset.order);

  transformer.forceUpdate();
  sortLayers();
  updateProperties();
}

for (const id of [
  "pos-x", "pos-y", "scale-x",
  "scale-y", "rotation", "layer-order",
]) {
  $(id).addEventListener("change", applyProperties);
}

$("visible").addEventListener("change", (event) => {
  const asset = currentAsset();
  if (!asset) return;

  asset.enabled = event.target.checked;
  refreshVisibility();
  renderAssetList();
  updateProperties();
});

$("category").addEventListener(
  "change",
  renderAssetList
);

// 本地 PNG 上传
$("upload").addEventListener("change", async (event) => {
  const category = $("category").value;

  for (const file of event.target.files) {
    if (file.type !== "image/png") {
      alert("目前仅支持 PNG 图片");
      continue;
    }

    const id = "asset_" + nextId++;
    const url = URL.createObjectURL(file);

    try {
      await addAsset({
        id,
        name: file.name.replace(/\.png$/i, ""),
        category,
        src: url,

        // 导出配置时使用的预期部署路径
        path: "/assets/imported/" + file.name,
      });
      $("status").textContent = "已导入：" + file.name;
    } catch (error) {
      alert(error.message);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  event.target.value = "";
});

// 恢复默认摆位
$("reset").addEventListener("click", () => {
  const asset = currentAsset();
  if (!asset) return;

  asset.node.position({
    x: asset.bounds.x,
    y: asset.bounds.y,
  });

  asset.node.scale({ x: 1, y: 1 });
  asset.node.rotation(0);

  transformer.forceUpdate();
  updateProperties();
});

// 导出 JSON 文件
$("export").addEventListener("click", () => {
  const config = {
    version: 2,
    canvas: { width: W, height: H },
    character: "/assets/character_base.png",
    assets: assets.map(serialize),
  };

  const blob = new Blob(
    [JSON.stringify(config, null, 2)],
    { type: "application/json" }
  );

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = "wardrobe.json";
  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// 从 JSON 恢复素材配置
$("import-json").addEventListener(
  "change",
  async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    try {
      const config = JSON.parse(await file.text());

      if (
        config.version !== 2 ||
        config.canvas?.width !== W ||
        config.canvas?.height !== H ||
        !Array.isArray(config.assets)
      ) {
        throw new Error("配置格式或画布尺寸不正确");
      }

      // 在加载新配置前先清理旧素材
      transformer.nodes([]);
      for (const asset of assets) {
        asset.node.destroy();
      }

      assets.length = 0;
      selectedId = null;

      for (const key of Object.keys(equipped)) {
        delete equipped[key];
      }

      for (const saved of config.assets) {
        await addAsset({
          id: saved.id,
          name: saved.name,
          category: saved.category,
          src: saved.image,
          path: saved.image,
          config: saved,
        });
      }

      // 恢复每一类实际选中的服饰
      for (const category of Object.keys(CATEGORIES)) {
        const active = config.assets.find(
          (a) => a.category === category &&
                 a.equipped
        );

        if (active) {
          equipped[category] = active.id;
        } else {
          delete equipped[category];
        }
      }

      refreshVisibility();
      renderAssetList();
      updateProperties();
      $("status").textContent = "配置导入成功";
    } catch (error) {
      alert("导入失败：" + error.message);
    }

    event.target.value = "";
  }
);

// 自适应浏览器宽度
function fitStage() {
  const container = $("stage-container");
  const width = Math.min(container.clientWidth, 490);
  if (!width) return;

  const scale = width / W;

  stage.width(width);
  stage.height(H * scale);
  stage.scale({ x: scale, y: scale });
}

// 初始化
async function initialize() {
  try {
    const bodyImage = await loadImage(
      "/assets/character_base.png"
    );

    if (bodyImage.width !== W || bodyImage.height !== H) {
      throw new Error("人物母版必须为 1024×1536");
    }

    const body = new Konva.Image({
      image: bodyImage,
      x: 0,
      y: 0,
      width: W,
      height: H,
      listening: false,
    });

    bodyLayer.add(body);

    await addAsset({
      id: "top_001",
      name: "粉色 T 恤",
      category: "tops",
      src: "/assets/tops/top_001.png",
      path: "/assets/tops/top_001.png",
    });

    fitStage();
    $("status").textContent = "编辑器已就绪";
  } catch (error) {
    console.error(error);
    $("status").textContent = error.message;
  }
}

window.addEventListener("resize", fitStage);

updateProperties();
initialize();
