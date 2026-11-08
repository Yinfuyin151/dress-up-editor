
import Konva from "konva";
import "./style.css";

// Krita 使用的统一画布尺寸
const WIDTH = 1024;
const HEIGHT = 1536;

// 素材路径
const BODY_PATH = "/assets/character_base.png";
const TOP_PATH = "/assets/tops/top_001.png";

const container = document.getElementById("stage-container");
const properties = document.getElementById("properties");

// 创建 Konva 舞台
const stage = new Konva.Stage({
  container: "stage-container",
  width: WIDTH,
  height: HEIGHT,
});

// 人物与服饰分别放在独立的图层中
const bodyLayer = new Konva.Layer();
const clothingLayer = new Konva.Layer();
const uiLayer = new Konva.Layer();

stage.add(bodyLayer);
stage.add(clothingLayer);
stage.add(uiLayer);

let clothing = null;
let transformer = null;

// 加载 PNG
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`图片加载失败：${src}`));
    img.src = src;
  });
}

// 根据浏览器宽度缩放显示舞台
// 注意：不改变实际的 1024x1536 坐标系
function fitStage() {
  const availableWidth = container.clientWidth;
  const scale = availableWidth / WIDTH;

  stage.width(WIDTH * scale);
  stage.height(HEIGHT * scale);
  stage.scale({ x: scale, y: scale });
}

// 读取当前服饰参数
function getClothingData() {
  if (!clothing) return null;

  return {
    id: "top_001",
    name: "粉色 T 恤",
    category: "tops",
    image: "assets/tops/top_001.png",
    x: Math.round(clothing.x() * 100) / 100,
    y: Math.round(clothing.y() * 100) / 100,
    width: WIDTH,
    height: HEIGHT,
    scaleX: clothing.scaleX(),
    scaleY: clothing.scaleY(),
    rotation: clothing.rotation(),
    zIndex: 30,
  };
}

// 刷新右侧参数面板
function updateProperties() {
  properties.textContent = JSON.stringify(
    getClothingData(),
    null,
    2
  );
}

// 加载并显示人物和衣服
async function initialize() {
  try {
    const [bodyImage, topImage] = await Promise.all([
      loadImage(BODY_PATH),
      loadImage(TOP_PATH),
    ]);

    // 检查导出的两张图是否尺寸一致
    for (const [name, img] of [
      ["人物", bodyImage],
      ["T恤", topImage],
    ]) {
      if (img.width !== WIDTH || img.height !== HEIGHT) {
        throw new Error(
          `${name}图片尺寸为 ${img.width}x${img.height}，` +
          `预期为 ${WIDTH}x${HEIGHT}。请检查 Krita 画布。`
        );
      }
    }

    // 固定人物底图
    const body = new Konva.Image({
      image: bodyImage,
      x: 0,
      y: 0,
      width: WIDTH,
      height: HEIGHT,
      listening: false,
    });

    bodyLayer.add(body);

    // 服饰图层，可拖动
    clothing = new Konva.Image({
      image: topImage,
      x: 0,
      y: 0,
      width: WIDTH,
      height: HEIGHT,
      draggable: true,
    });

    clothingLayer.add(clothing);

    // 缩放与旋转控制框
    transformer = new Konva.Transformer({
      nodes: [clothing],
      rotateEnabled: true,
      flipEnabled: false,
      keepRatio: false,
      borderStroke: "#cf71a0",
      anchorStroke: "#cf71a0",
      anchorFill: "#ffffff",
      anchorSize: 10,
    });

    uiLayer.add(transformer);

    clothing.on("dragmove transform", updateProperties);
    clothing.on("dragend transformend", updateProperties);

    fitStage();
    updateProperties();
  } catch (error) {
    console.error(error);
    properties.textContent = error.message;
  }
}

// 恢复 Krita 的原始对齐位置
document.getElementById("reset").addEventListener("click", () => {
  if (!clothing) return;

  clothing.position({ x: 0, y: 0 });
  clothing.scale({ x: 1, y: 1 });
  clothing.rotation(0);

  transformer.forceUpdate();
  updateProperties();
});

// 导出服饰配置 JSON
document.getElementById("export").addEventListener("click", () => {
  if (!clothing) return;

  const config = {
    canvas: { width: WIDTH, height: HEIGHT },
    clothing: getClothingData(),
  };

  const json = JSON.stringify(config, null, 2);
  const blob = new Blob([json], {
    type: "application/json",
  });

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = "top_001.json";
  link.click();

  URL.revokeObjectURL(url);
});

// 处理浏览器窗口尺寸变化
window.addEventListener("resize", fitStage);

initialize();
