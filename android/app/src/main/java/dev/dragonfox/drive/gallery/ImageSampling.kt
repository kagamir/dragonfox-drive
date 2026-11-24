package dev.dragonfox.drive.gallery

/** BitmapFactory samples in powers of two. Use ceil sizes so odd dimensions obey both budgets. */
internal fun sampleSize(width: Int, height: Int, maxEdge: Int, maxPixels: Long): Int {
    if (width <= 0 || height <= 0) return 1
    var sample = 1
    while (true) {
        val w = (width.toLong() + sample - 1) / sample
        val h = (height.toLong() + sample - 1) / sample
        if (maxOf(w, h) <= maxEdge && w * h <= maxPixels) return sample
        if (sample >= 1 shl 30) return sample
        sample *= 2
    }
}
