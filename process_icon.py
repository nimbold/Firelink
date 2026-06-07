import sys
from PIL import Image, ImageDraw

def process_images(src_path):
    img = Image.open(src_path).convert("RGBA")

    # Crop the 28px black padding
    img = img.crop((28, 28, 1226, 1226))
    width, height = img.size
    pixels = img.load()

    # Lighter color (+1) at top, original color (0) at bottom
    bg_color = pixels[100, 100]
    # Use a 1.9x multiplier for a subtle, modern "lit from above" macOS effect
    top_color = (min(255, int(bg_color[0] * 1.9)), min(255, int(bg_color[1] * 1.9)), min(255, int(bg_color[2] * 1.9)), 255)
    bottom_color = (bg_color[0], bg_color[1], bg_color[2], 255)

    new_img = Image.new("RGBA", (width, height))
    new_pixels = new_img.load()

    for y in range(height):
        ratio = y / float(height - 1)
        grad_r = int(top_color[0] * (1 - ratio) + bottom_color[0] * ratio)
        grad_g = int(top_color[1] * (1 - ratio) + bottom_color[1] * ratio)
        grad_b = int(top_color[2] * (1 - ratio) + bottom_color[2] * ratio)
        grad_color = (grad_r, grad_g, grad_b, 255)

        for x in range(width):
            p = pixels[x, y]
            dist = max(abs(p[0]-bg_color[0]), abs(p[1]-bg_color[1]), abs(p[2]-bg_color[2]))

            # Replace pure black corners or background with gradient
            if p[0] < 15 and p[1] < 15 and p[2] < 15:
                new_pixels[x, y] = grad_color
            elif dist < 15:
                new_pixels[x, y] = grad_color
            elif dist < 60:
                alpha = (dist - 15) / 45.0
                r = int(p[0] * alpha + grad_color[0] * (1 - alpha))
                g = int(p[1] * alpha + grad_color[1] * (1 - alpha))
                b = int(p[2] * alpha + grad_color[2] * (1 - alpha))
                new_pixels[x, y] = (r, g, b, 255)
            else:
                new_pixels[x, y] = p

    img = new_img
    radius = int(width * 0.225)
    mask = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, width, height), radius=radius, fill=255)
    img.putalpha(mask)

    # Save standard png
    img_1024 = img.resize((1024, 1024), Image.Resampling.LANCZOS)
    img_1024.save("Resources/AppIcon.png")

    # Save Firefox extension icons
    img_48 = img.resize((48, 48), Image.Resampling.LANCZOS)
    img_48.save("Extensions/Firefox/icons/icon-48.png")
    img_128 = img.resize((128, 128), Image.Resampling.LANCZOS)
    img_128.save("Extensions/Firefox/icons/icon-128.png")

    # MenuBarIconTemplate (64x64 monochrome)
    data = img.getdata()
    new_data = []

    for item in data:
        r, g, b, a = item
        if r > 100 and r > b * 1.5 and a > 0:
            alpha = min(255, max(0, int((r - 40) * 1.2)))
            new_data.append((0, 0, 0, alpha))
        else:
            new_data.append((0, 0, 0, 0))

    menu_bar_full = Image.new("RGBA", img.size)
    menu_bar_full.putdata(new_data)

    menu_bar_64 = menu_bar_full.resize((64, 64), Image.Resampling.LANCZOS)
    menu_bar_64.save("Sources/Firelink/Assets.xcassets/MenuBarIcon.imageset/MenuBarIconTemplate.png")

    print("Done generating main PNGs")

if __name__ == '__main__':
    process_images(sys.argv[1])
